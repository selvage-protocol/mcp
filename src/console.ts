/**
 * Where this process's console writes.
 *
 * Everything printed on stdout is a message: on stdio the stream carries newline-delimited
 * JSON-RPC and nothing else, and a client that reads a cheerfully printed line as a message is a
 * frame out of step for the rest of the session. On this runtime `console.log`, `info`, `debug`,
 * `dir`, `table`, `count`, `countReset`, `group`, `groupEnd`, `time`, `timeEnd`, `timeLog` and a
 * failed `assert` all reach stdout, while `error`, `warn` and `trace` already reach stderr. That
 * list belongs to the runtime and not to this repository, and a guard that is wrong about it is a
 * corrupted frame rather than a cosmetic problem, so no list is kept: the console is rebuilt with
 * `stdout` and `stderr` pointed at the same stderr stream, and then no method of it — nor one a
 * later revision adds, nor a method reached through a `Console` a library builds from this global
 * — can reach the wire.
 */

import { Console } from 'node:console';
import type { Writable } from 'node:stream';

/**
 * Points every `console` method at `stderr`, which has to be the process's own: what the
 * specification allows a server to write there is a string a client may show or ignore, and
 * nothing there is a message.
 */
export function consoleToStderr(stderr: Writable): void {
  globalThis.console = new Console({ stdout: stderr, stderr, colorMode: false });
}
