/**
 * The changed region a wait or a notification reports: the hunk renderer and the line/column
 * counter, as pure functions with no room behind them.
 *
 * The shape is what matters here — a `-` line and a `+` line with line numbers, context around
 * them, a bound, and an honest empty answer for two texts that agree. What a room does to a
 * document is `session-wait.test.ts`; what a hunk looks like is this.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_HUNK_LINES, positionAt, renderHunk } from '../src/changes.ts';

test('a hunk marks the old line and the new one, numbered, with context around them', () => {
  const before = 'first\nsecond\nthird\nfourth\nfifth\n';
  const after = 'first\nsecond\nTHIRD\nfourth\nfifth\n';
  const hunk = renderHunk(before, after);
  assert.equal(hunk.truncated, false);
  assert.deepEqual(hunk.lines, [
    '     1 first',
    '     2 second',
    '-    3 third',
    '+    3 THIRD',
    '     4 fourth',
    '     5 fifth',
  ]);
});

test('a hunk widens a mid-line change to the whole line, the way a unified diff does', () => {
  const hunk = renderHunk('ada types here\n', 'grace types here\n');
  assert.deepEqual(hunk.lines, ['-    1 ada types here', '+    1 grace types here']);
});

test('an insertion at the end shows only the added lines, not the line it was appended to', () => {
  const hunk = renderHunk('one\n', 'one\ntwo\n');
  assert.deepEqual(hunk.lines, ['     1 one', '+    2 two']);
});

test('a deletion shows the lines that went, and the new number after them', () => {
  const hunk = renderHunk('one\nXX\nthree\n', 'one\nthree\n');
  assert.deepEqual(hunk.lines, [
    '     1 one',
    '-    2 XX',
    '     2 three',
  ]);
});

test('two texts that agree have no hunk at all', () => {
  assert.deepEqual(renderHunk('same\n', 'same\n'), { lines: [], truncated: false });
});

test('a change too large for the bound is cut, and says it was', () => {
  const before = Array.from({ length: 200 }, (_, at) => `line ${at}`).join('\n');
  const after = Array.from({ length: 200 }, (_, at) => `changed ${at}`).join('\n');
  const hunk = renderHunk(before, after);
  assert.equal(hunk.truncated, true);
  assert.equal(hunk.lines.length, MAX_HUNK_LINES);
});

test('a line longer than the report can hold is cut, and the hunk says so', () => {
  const long = 'x'.repeat(1_000);
  const hunk = renderHunk(`${long}\n`, `${long}y\n`);
  assert.equal(hunk.truncated, true);
  assert.equal(hunk.lines.length, 2);
  for (const line of hunk.lines) {
    assert.ok(line.length < 300, `a hunk line was ${line.length} characters`);
  }
});

test('a hunk refuses malformed before, after, and equal inputs without rendering halves', () => {
  for (const malformed of ['\ud800', '\udfff', 'one\n\ud800tail', '😀\udfff']) {
    for (const [before, after] of [[malformed, 'valid😀'], ['valid😀', malformed], [malformed, malformed]] as const) {
      assert.deepEqual(renderHunk(before, after), {
        lines: [], truncated: false,
        refusal: 'cannot report text containing an unpaired UTF-16 surrogate',
      });
    }
  }
});

test('hunks preserve astral characters and never cut between their halves', () => {
  assert.deepEqual(renderHunk('x😀y\n', 'x😁y\n'), {
    lines: ['-    1 x😀y', '+    1 x😁y'], truncated: false,
  });
  assert.deepEqual(renderHunk('😀', '😀'), { lines: [], truncated: false });
  // The pair straddles the 200-code-unit line bound, on both removed and inserted lines.
  const prefix = 'x'.repeat(199);
  const hunk = renderHunk(`${prefix}😀old\n`, `${prefix}😁new\n`);
  assert.equal(hunk.refusal, undefined);
  assert.equal(hunk.truncated, true);
  assert.deepEqual(hunk.lines, [`-    1 ${prefix}…`, `+    1 ${prefix}…`]);
  for (const line of hunk.lines) {
    for (const character of line) {
      const point = character.codePointAt(0) as number;
      assert.ok(point < 0xd800 || point > 0xdfff, 'a hunk contains an unpaired surrogate');
    }
  }
});

test('an offset counts into a one-based line and column, whichever text it was taken in', () => {
  const text = 'one\ntwo\nthree';
  assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, 3), { line: 1, column: 4 });
  assert.deepEqual(positionAt(text, 4), { line: 2, column: 1 });
  assert.deepEqual(positionAt(text, 8), { line: 3, column: 1 });
  assert.deepEqual(positionAt(text, text.length), { line: 3, column: 6 });
  // An offset past the end is clamped rather than counting lines that are not there.
  assert.deepEqual(positionAt(text, 99), { line: 3, column: 6 });
});
