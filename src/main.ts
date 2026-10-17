#!/usr/bin/env node
/**
 * The server as an MCP client starts it: a subprocess that speaks JSON-RPC 2.0 over stdin and
 * stdout and exits when stdin closes. `bin` in `package.json` names this file, so `selvage-mcp`
 * and `node <path>/src/main.ts` are the same process; the shebang and the executable bit are what
 * make the first one true, and Node strips the types from a `.ts` file as it loads it.
 *
 * Everything it can say is in `src/stdio.ts` and everything it decides is in `src/server.ts`. What
 * is left here is what only a process has: a stream's worth of wiring, a version to name itself by
 * (read from the package rather than repeated as a constant, because the one guaranteed way to get
 * it wrong is to have it in two places), the console turned away from the protocol's own stream
 * (`src/console.ts`), and the session this process holds being left when its client closes stdin —
 * the engine's socket is not `unref`ed, so nothing else would end it.
 */

import { readFileSync } from 'node:fs';

import { consoleToStderr } from './console.ts';
import type { Session as LiveSession } from './session.ts';
import { ToolRegistry } from './registry.ts';
import { Server } from './server.ts';
import type { ServerInfo } from './server.ts';
import { serve } from './stdio.ts';

// `./notify.ts` is imported here rather than lazily below because `./server.ts` already reaches
// it statically for `LOG_LEVELS`: it is in the entry chunk whatever this file does, and reaching
// it lazily as well only splits its code into a chunk the entry then imports ahead of the rest.
import { ActivityChannel } from './notify.ts';

/**
 * Anything this process prints on stdout is a message, so a diagnostic goes to stderr — where
 * the client may show it or ignore it, and where `2025-11-25/basic/transports.mdx` says so.
 */
function diagnostic(message: string): void {
  process.stderr.write(`selvage-mcp: ${message}\n`);
}

// The console is turned around before anything else can reach for it — this file, a tool, the
// vendored engine, a library behind either of them — because on this runtime two thirds of it
// writes to stdout, and stdout is the protocol's. `src/console.ts` holds why the guard is the
// whole console rather than a list of the methods that happen to reach stdout today.
consoleToStderr(process.stderr);

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

/** How long leaving the session may take at end of input before this process stops waiting. */
const LEAVE_MS = 2_000;

/**
 * Ends the session this process held, bounded.
 *
 * End of input *is* the shutdown — `2025-11-25/basic/lifecycle.mdx` has the client close stdin
 * and then wait for the process to exit — and the sync engine's socket is not `unref`ed, so a
 * connected host or guest would keep the event loop alive past the client that started it, which
 * the stdio transport does not allow. Leaving is what ends that connection, and for a host it
 * also ends the room, which is the right end of a host's process: the folder it shared is not
 * being served any more.
 *
 * The wait is bounded because a room that will not answer must not keep this process up either:
 * past the deadline the connection has not come back, so the process ends with a diagnostic and a
 * failed exit rather than outliving its client, which is the one thing the transport forbids.
 */
async function leaving(session: LiveSession): Promise<void> {
  if (!session.hasSession()) {
    return;
  }
  diagnostic('leaving the session');
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.leave(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          reject(new Error(`the room did not answer within ${LEAVE_MS} ms`));
        }, LEAVE_MS);
      }),
    ]);
  } catch (error: unknown) {
    await lastWords(
      `leaving the session: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (deadline !== undefined) {
      clearTimeout(deadline);
    }
  }
}

/**
 * The last thing this process says, written and then waited for before it ends: `process.exit`
 * drops bytes still on their way to a pipe, and this sentence is the only report of why a process
 * whose client is gone is ending anyway.
 */
async function lastWords(message: string): Promise<never> {
  process.exitCode = 1;
  await new Promise<void>((written) => {
    process.stderr.write(`selvage-mcp: ${message}\n`, () => {
      written();
    });
  });
  process.exit(1);
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

const activity = new ActivityChannel();
const session = new Session({ notify: (one) => activity.deliver(one) });
const registry = new ToolRegistry();
for (const tool of createSessionTools(session)) {
  registry.register(tool);
}

const server = new Server({ serverInfo: packageInfo(), log: diagnostic, registry, logging: activity });

try {
  await serve(server, {
    input: process.stdin,
    output: process.stdout,
    diagnostic,
    onWriter: (write) => activity.attach(write),
  });
  diagnostic('stdin closed; stopping');
} catch (error: unknown) {
  diagnostic(`stopping: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await leaving(session);
}
