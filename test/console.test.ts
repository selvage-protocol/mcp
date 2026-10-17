/**
 * The process's console, held to the one rule the transport has for it: nothing it prints may
 * reach stdout, because on stdio stdout carries newline-delimited JSON-RPC and nothing else.
 *
 * The methods driven here are every one that reaches stdout on this runtime, and the streams they
 * reach are the real ones with their writes recorded, so a method left writing to stdout is a red
 * test rather than a puzzled client. `console.error`, `warn` and `trace` already went to stderr
 * and are driven too, because the guard must not send them anywhere else.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { consoleToStderr } from '../src/console.ts';

interface Recorded {
  readonly chunks: string[];
  restore(): void;
}

/** `stream` with its writes collected, for as long as the caller holds the recording. */
function recording(stream: NodeJS.WriteStream): Recorded {
  const chunks: string[] = [];
  const real = stream.write;
  stream.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    chunks,
    restore: () => {
      stream.write = real;
    },
  };
}

test('every console method that reaches stdout is turned around to stderr', () => {
  const stdout = recording(process.stdout);
  const stderr = recording(process.stderr);
  const console_ = globalThis.console;
  try {
    consoleToStderr(process.stderr);
    console.log('a log');
    console.info('an info');
    console.debug('a debug');
    console.dir({ a: 'a dir' });
    console.table([{ a: 'a table' }]);
    console.count('a count');
    console.countReset('a count');
    console.group('a group');
    console.groupEnd();
    console.time('a timer');
    console.timeLog('a timer');
    console.timeEnd('a timer');
    console.assert(false, 'an assert');
    console.warn('a warn');
    console.error('an error');
    console.trace('a trace');
  } finally {
    globalThis.console = console_;
    stdout.restore();
    stderr.restore();
  }

  assert.deepEqual(
    stdout.chunks,
    [],
    `the console wrote to stdout, which is the protocol's: ${stdout.chunks.join('')}`,
  );
  const written = stderr.chunks.join('');
  for (const marker of [
    'a log',
    'an info',
    'a debug',
    'a dir',
    'a table',
    'a count',
    'a group',
    'a timer',
    'an assert',
    'a warn',
    'an error',
    'a trace',
  ]) {
    assert.ok(written.includes(marker), `${marker} did not reach stderr: ${JSON.stringify(written)}`);
  }
});
