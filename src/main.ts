#!/usr/bin/env node
/**
 * The server as an MCP client starts it: a subprocess that speaks JSON-RPC 2.0 over stdin and
 * stdout and exits when stdin closes. `bin` in `package.json` names this file, so `selvage-mcp`
 * and `node <path>/src/main.ts` are the same process; the shebang and the executable bit are what
 * make the first one true, and Node strips the types from a `.ts` file as it loads it.
 *
 * Everything it can say is in `src/stdio.ts` and everything it decides is in `src/server.ts`. What
 * is left here is the two things a process has to have: a stream's worth of wiring, and a version
 * to name itself by. That version is read from the package rather than repeated as a constant,
 * because the one guaranteed way to get it wrong is to have it in two places.
 */

import { readFileSync } from 'node:fs';
import { format } from 'node:util';

import { ToolRegistry } from './registry.ts';
import { Server } from './server.ts';
import type { ServerInfo } from './server.ts';
import { serve } from './stdio.ts';

/**
 * Anything this process prints on stdout is a message, so a diagnostic goes to stderr — where
 * the client may show it or ignore it, and where `2025-11-25/basic/transports.mdx` says so.
 */
function diagnostic(message: string): void {
  process.stderr.write(`selvage-mcp: ${message}\n`);
}

/**
 * The console is turned around before anything else can reach for it, because `console.log`
 * writes to stdout, and stdout is the protocol's: a cheerfully printed line, from this file, from
 * a tool, from the vendored engine or from a library behind it, is not a message, and a client
 * that reads one as a message is a frame out of step for the rest of the session. `console.error`
 * already goes to stderr; these three are the ones that would have gone to the wire.
 */
for (const method of ['log', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]): void => {
    diagnostic(format(...args));
  };
}

/**
 * The browser-storage global the engine's own dependency reads as it is evaluated. A Node
 * process has no `localStorage` — unless one was started with a storage file, in which case Node
 * answers there — and merely reading the global otherwise warns. Left to itself that warning
 * reaches stderr ahead of this process's first diagnostic, from a module that only asked whether
 * a browser was there; answered here as absent, the dependency keeps the in-memory fallback it
 * already uses with no browser in sight.
 */
Object.defineProperty(globalThis, 'localStorage', {
  value: undefined,
  configurable: true,
  writable: true,
});

// Imported here rather than at the top of the file, because evaluating them is what reads the
// global above.
const { Session } = await import('./session.ts');
const { createSessionTools } = await import('./tools.ts');

/** The name and version this server announces, off the package it was installed as. */
function packageInfo(): ServerInfo {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('../package.json is not an object');
  }
  const { name, version } = parsed as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('../package.json names no package or no version');
  }
  return { name, version };
}

/**
 * A `stdout` this process cannot write to — a client that closed the pipe — is reported and
 * remembered, not thrown from an event handler: the write that found it is already on its way
 * back through `serve`, and that is where the exit code comes from.
 */
process.stdout.on('error', (error: unknown) => {
  diagnostic(`stdout: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

const registry = new ToolRegistry();
for (const tool of createSessionTools(new Session())) {
  registry.register(tool);
}

const server = new Server({ serverInfo: packageInfo(), log: diagnostic, registry });

try {
  await serve(server, {
    input: process.stdin,
    output: process.stdout,
    diagnostic,
  });
  diagnostic('stdin closed; stopping');
} catch (error: unknown) {
  diagnostic(`stopping: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
