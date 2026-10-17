/**
 * A server started the way a client starts one: a child process, one JSON message per line on
 * stdin, one per line back on stdout, diagnostics on stderr.
 *
 * The tests speak the real surface rather than the `Server` object, because the parts that are
 * only true of a process — the framing, the empty stdout of a notification, stdout that carries
 * nothing but messages, EOF as the shutdown — are exactly the parts a second implementation in
 * the test would get to choose.
 *
 * Every wait is bounded and every failure carries what was seen: a message the server never sent
 * fails the test with the lines it did send, its stderr and its exit state, rather than hanging
 * until the runner gives up. Nothing here sleeps.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The entry point `bin` names, started the way a client starts it. */
export const ENTRY = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

/** What a client process is given that a library is not. */
export interface SpawnOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** How long any single wait may take before the test is failed with what was observed. */
const WAIT_MS = 10_000;

interface ExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export class StdioServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly raw: string[] = [];
  private readonly queued: string[] = [];
  private waiter: ((line: string) => void) | undefined;
  private diagnosticWaiter: { text: string; wait: () => void } | undefined;
  private tail = '';
  private diagnostics = '';
  private exitState: ExitState | undefined;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.absorb(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.diagnostics += chunk;
      const waiter = this.diagnosticWaiter;
      if (waiter !== undefined && this.diagnostics.includes(waiter.text)) {
        this.diagnosticWaiter = undefined;
        waiter.wait();
      }
    });
    child.on('exit', (code, signal) => {
      this.exitState = { code, signal };
    });
  }

  /** The entry point the tests drive, started under the interpreter running the tests. */
  static start(options: SpawnOptions = {}): StdioServer {
    return StdioServer.startCommand(process.execPath, [ENTRY], options);
  }

  /**
   * Anything at all that speaks this protocol on its standard input and output — a command and
   * its arguments, which for `bin` means the file itself, run through its own shebang. The
   * options are what a client process has and a library does not: a working directory of its
   * own, and an environment the server reads a default out of.
   */
  static startCommand(
    command: string,
    args: readonly string[] = [],
    options: SpawnOptions = {},
  ): StdioServer {
    return new StdioServer(
      spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.env === undefined ? {} : { env: options.env }),
      }),
    );
  }

  /** Every line the server wrote on stdout, in order, as it stood when it was written. */
  stdout(): readonly string[] {
    return this.raw;
  }

  /** Everything stdout carried, byte for byte, for the check that none of it is anything else. */
  rawStdout(): string {
    return this.raw.map((line) => `${line}\n`).join('') + this.tail;
  }

  /** Everything the server wrote on stderr so far. */
  stderr(): string {
    return this.diagnostics;
  }

  /** Writes one message, as one line. */
  send(message: unknown): void {
    this.sendRaw(JSON.stringify(message));
  }

  /** Writes one raw line, for the messages JSON cannot spell — the malformed ones. */
  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  /**
   * The next line stdout produced. Resolves as soon as one is there rather than waiting for one
   * that never comes; the timeout kills the child, so a failed wait cannot leave a process behind.
   *
   * The bound is the caller's, because one wait is the room's own rather than this harness's: a
   * read a joiner has to be committed before it can ask for can take the room's renewal window,
   * which is longer than anything a unit test waits for.
   */
  async nextLine(what: string, ms: number = WAIT_MS): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) {
      return queued;
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        this.child.kill('SIGKILL');
        reject(new Error(`timed out after ${ms}ms waiting for ${what}\n${this.report()}`));
      }, ms);
      this.waiter = (line) => {
        clearTimeout(timer);
        resolve(line);
      };
    });
  }

  /** The next line, required to be the JSON-RPC response to `id`. */
  async nextResponse(id: string | number, what: string, ms: number = WAIT_MS): Promise<Record<string, unknown>> {
    const line = await this.nextLine(what, ms);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The commonest way for this to happen is something having written prose to stdout, which
      // the report shows in full rather than as the JSON parser's complaint about its first letter.
      throw new Error(
        `stdout carried something that is not a JSON message: ${JSON.stringify(line)}\n${this.report()}`,
      );
    }
    assert.ok(typeof parsed === 'object' && parsed !== null, `not an object: ${line}`);
    const message = parsed as Record<string, unknown>;
    assert.equal(message['jsonrpc'], '2.0', `not a JSON-RPC message: ${line}`);
    assert.equal(message['id'], id, `response to another request: ${line}`);
    return message;
  }

  /** The `result` of the next response, failing on a response that carries an `error` instead. */
  async nextResult(id: string | number, what: string, ms: number = WAIT_MS): Promise<unknown> {
    const response = await this.nextResponse(id, what, ms);
    assert.ok(!('error' in response), `expected a result, got ${JSON.stringify(response)}`);
    return response['result'];
  }

  /** The `error` of the next response, failing on a response that carries a `result` instead. */
  async nextError(id: string | number, what: string): Promise<Record<string, unknown>> {
    const response = await this.nextResponse(id, what);
    assert.ok('error' in response, `expected an error, got ${JSON.stringify(response)}`);
    return response['error'] as Record<string, unknown>;
  }

  /**
   * A diagnostic on stderr, waited for rather than assumed: the two pipes are separate, so a line
   * written before a response is not necessarily readable by the time the response is.
   */
  async waitForDiagnostic(text: string, what: string): Promise<void> {
    if (this.diagnostics.includes(text)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnosticWaiter = undefined;
        this.child.kill('SIGKILL');
        reject(new Error(`timed out after ${WAIT_MS}ms waiting for ${what}\n${this.report()}`));
      }, WAIT_MS);
      this.diagnosticWaiter = {
        text,
        wait: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
  }

  /** Closes stdin, which is the shutdown, and returns how the process left. */
  async close(): Promise<ExitState> {
    this.child.stdin.end();
    return this.waitForExit(`the server to exit after stdin closed`);
  }

  /** Kills the child if it is still there, and waits for it to be gone. */
  async stop(): Promise<void> {
    if (this.exitState !== undefined) {
      return;
    }
    this.child.kill('SIGKILL');
    try {
      await this.waitForExit('the server to die');
    } catch {
      // Nothing left to do about a process that outlived SIGKILL; the runner reports the leak.
    }
  }

  /** Everything observed so far, for a failure message. */
  report(): string {
    return [
      `stdout (${this.raw.length} lines):`,
      ...this.raw.map((line) => `  ${line}`),
      `stderr: ${this.diagnostics === '' ? '(empty)' : JSON.stringify(this.diagnostics)}`,
      `exit: ${this.exitState === undefined ? 'still running' : JSON.stringify(this.exitState)}`,
      ...(this.tail === '' ? [] : [`unterminated stdout tail: ${JSON.stringify(this.tail)}`]),
    ].join('\n');
  }

  private absorb(chunk: string): void {
    this.tail += chunk;
    let newline = this.tail.indexOf('\n');
    while (newline !== -1) {
      const line = this.tail.slice(0, newline);
      this.tail = this.tail.slice(newline + 1);
      this.raw.push(line);
      const waiter = this.waiter;
      if (waiter === undefined) {
        this.queued.push(line);
      } else {
        this.waiter = undefined;
        waiter(line);
      }
      newline = this.tail.indexOf('\n');
    }
  }

  private waitForExit(what: string): Promise<ExitState> {
    const state = this.exitState;
    if (state !== undefined) {
      return Promise.resolve(state);
    }
    return new Promise<ExitState>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        reject(new Error(`timed out after ${WAIT_MS}ms waiting for ${what}\n${this.report()}`));
      }, WAIT_MS);
      this.child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }
}

/**
 * A file started the way a shell starts it — through its own shebang — or, where there is no
 * `/usr/bin/env` to find an interpreter with (a Nix build sandbox has no `/usr/bin` at all),
 * under the Node this suite runs on. Both branches run the same file and answer the same way;
 * only the interpreter that ends up running it differs, and `how` says which one it was, for a
 * failure message to name.
 */
export function startFile(
  path: string,
  options: SpawnOptions = {},
): { readonly server: StdioServer; readonly how: string } {
  return existsSync('/usr/bin/env')
    ? { server: StdioServer.startCommand(path, [], options), how: 'through its own shebang' }
    : {
        server: StdioServer.startCommand(process.execPath, [path], options),
        how: 'under the Node this suite runs on, the sandbox having no /usr/bin/env',
      };
}

/**
 * Every line stdout carried, held to what the specification requires of the stream: one JSON-RPC
 * message per line, nothing else, ending in a newline. A `console.log`, a pretty-printed message
 * or a missing trailing newline is a red test here rather than a puzzled client later.
 */
export function assertMessagesOnly(raw: string): Record<string, unknown>[] {
  assert.ok(raw.endsWith('\n'), `stdout does not end with a newline: ${JSON.stringify(raw)}`);
  const lines = raw.split('\n');
  lines.pop();
  return lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    assert.ok(typeof parsed === 'object' && parsed !== null, `not an object: ${line}`);
    const message = parsed as Record<string, unknown>;
    assert.equal(message['jsonrpc'], '2.0', `not a JSON-RPC message: ${line}`);
    assert.ok(!line.includes('\r'), `carriage return in ${JSON.stringify(line)}`);
    return message;
  });
}
