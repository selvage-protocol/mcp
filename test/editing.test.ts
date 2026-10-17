/**
 * The document policy every edit runs through: the smallest replacement between two texts, and
 * the change it describes put back. `vendor/` is a copy of the editor clients' bridge, and this
 * is the half of it this adapter's edit path depends on — `Session.transform` works one `diff`
 * out and publishes the delete and the insert it names, so a `diff` that named a range it does
 * not reconstruct would be a document this server put in the room apart from the one the caller
 * asked for, which is where a doubled or truncated document would come from.
 *
 * The corpus is generated rather than listed, and from a seed of its own rather than from the
 * clock: a case that fails is one a reader reaches again by running the test again. What it
 * covers is what a document can hold — newlines, a carriage return, and a two-code-unit character
 * whose halves a range must never fall between. It holds no lone surrogate, because none is
 * reachable: a granted file is decoded as strict UTF-8, and an editor's buffer holds whole
 * characters.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { applyChange, diff } from '../vendor/bridge/index.ts';

/** How many pairs one run generates: enough for the widening cases, small enough for the suite. */
const CASES = 20_000;

/** What a text is built from, including the astral character the range widening exists for. */
const ALPHABET = ['a', 'b', 'c', '\n', ' ', '\r', '😀', 'é', '\t'];

/** A deterministic generator, so a failing pair is one the next run reaches again. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state;
  };
}

function textFrom(next: () => number, limit: number): string {
  let out = '';
  const length = next() % (limit + 1);
  for (let at = 0; at < length; at += 1) {
    out += ALPHABET[next() % ALPHABET.length];
  }
  return out;
}

/** Whether `at` falls between the two halves of one astral character. */
function splitsPair(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }
  const high = text.charCodeAt(at - 1);
  const low = text.charCodeAt(at);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

test('the smallest change between two texts reproduces the second, in whole and in range', () => {
  const next = generator(20_260_101);
  for (let round = 0; round < CASES; round += 1) {
    const from = textFrom(next, 24);
    const to = textFrom(next, 24);
    const change = diff(from, to);
    const described = JSON.stringify({ from, to, change });

    assert.ok(
      change.start >= 0 && change.end >= change.start && change.end <= from.length,
      `the range is not inside the text it changes: ${described}`,
    );
    assert.ok(
      !splitsPair(from, change.start) && !splitsPair(from, change.end),
      `the range falls between the halves of one character: ${described}`,
    );
    assert.equal(applyChange(from, change), to, `the change does not reproduce the second text: ${described}`);
    // What `Session.transform` publishes: the delete of `[start, end)` and the insert of `text`.
    // The text a peer is handed has to be whole as well, which is what the widening is for.
    assert.equal(
      from.slice(0, change.start) + change.text + from.slice(change.end),
      to,
      `the published delete and insert do not reconstruct the second text: ${described}`,
    );
    assert.ok(!splitsPair(to, change.start), `the inserted text begins between two halves of one character: ${described}`);
    const first = change.text.charCodeAt(0);
    const last = change.text.charCodeAt(change.text.length - 1);
    assert.ok(
      !(first >= 0xdc00 && first <= 0xdfff) && !(last >= 0xd800 && last <= 0xdbff),
      `the inserted text begins or ends with half a character: ${described}`,
    );
  }
});
