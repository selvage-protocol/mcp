/**
 * What a wait or a notification says about one document: the smallest region that changed,
 * widened to whole lines and cut to a bound.
 *
 * The region is one range, not a general diff. `diff` answers the smallest single replacement
 * that turns one text into another, which is the shape a hunk is: a wait reports what the room
 * did to a document since the last wait, and a document that moved under two hands is still one
 * region from where the wait last looked to where it looks now. A general multi-hunk diff would
 * describe edits the agent was never shown.
 *
 * Everything here is pure and counts UTF-16 code units, the unit `Y.Text` indices and the
 * adapter's own offsets already count in.
 */

import { diff } from '../vendor/bridge/index.ts';
import type { TextChange } from '../vendor/bridge/index.ts';

/** How many unchanged lines stand on each side of a changed region. */
export const HUNK_CONTEXT_LINES = 3;

/** How many lines one hunk may hold, before it says it was cut. */
export const MAX_HUNK_LINES = 30;

/**
 * How many characters one hunk line may hold. A file can hold a line longer than the whole report
 * bound — a minified bundle is one line — so the line is cut as well as the region.
 */
export const MAX_HUNK_LINE_CHARS = 200;

/** A changed region as lines an agent reads: a `-` line is the old text, a `+` line the new. */
export interface Hunk {
  readonly lines: readonly string[];
  /** Whether the region held more lines than {@link MAX_HUNK_LINES} and was cut. */
  readonly truncated: boolean;
  /** Malformed inputs are refused without rendering or normalizing either text. */
  readonly refusal?: string;
}

/** The start offset of every line in a text, including the empty line a trailing newline leaves. */
function lineStartsOf(text: string): number[] {
  const starts: number[] = [0];
  let at = text.indexOf('\n');
  while (at !== -1) {
    starts.push(at + 1);
    at = text.indexOf('\n', at + 1);
  }
  return starts;
}

/** The index of the line an offset sits on, in the text the offset was counted in. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** One line without its newline, read only when a hunk actually prints it. */
function lineText(text: string, starts: readonly number[], index: number): string {
  const start = starts[index] ?? text.length;
  const end = text.indexOf('\n', start);
  return text.slice(start, end === -1 ? text.length : end);
}

/** The start of the line an offset sits on. */
function lineStart(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, text.length));
  return text.lastIndexOf('\n', clamped - 1) + 1;
}

/** The offset after the line an offset sits on, so a region can end at a line boundary. */
function lineEnd(text: string, offset: number): number {
  const at = text.indexOf('\n', Math.max(0, offset));
  return at === -1 ? text.length : at + 1;
}

/** A block of text as whole lines, with the empty line a trailing newline leaves out. */
function blockLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/**
 * The changed region of `after` against `before`, as `-`/`+` lines with line numbers and a few
 * lines of context. An empty `lines` means the two texts agree, or differ only in a way this
 * single region cannot name.
 */
export function renderHunk(before: string, after: string): Hunk {
  let change: TextChange;
  try {
    change = diff(before, after);
  } catch (error: unknown) {
    if (
      error instanceof RangeError &&
      error.message === 'cannot diff text containing an unpaired UTF-16 surrogate'
    ) {
      return { lines: [], truncated: false, refusal: 'cannot report text containing an unpaired UTF-16 surrogate' };
    }
    throw error;
  }
  if (change.start === change.end && change.text === '') {
    return { lines: [], truncated: false };
  }
  const starts = lineStartsOf(before);
  // The region is widened to whole lines: a change in the middle of a line is reported as the
  // whole line replaced, which is what a reader of a unified diff expects and what keeps the
  // line numbers honest. A pure insertion at a line boundary touches no old line at all.
  const atBoundary = change.start > 0 && before[change.start - 1] === '\n';
  const from = change.end > change.start || !atBoundary ? lineStart(before, change.start) : change.start;
  const to =
    change.end > change.start
      ? lineEnd(before, change.end - 1)
      : atBoundary
        ? from
        : lineEnd(before, change.start);
  const removed = blockLines(before.slice(from, to));
  const inserted = blockLines(before.slice(from, change.start) + change.text + before.slice(change.end, to));
  const firstChanged = lineAt(starts, from);
  const lastChanged = removed.length === 0 ? firstChanged - 1 : firstChanged + removed.length - 1;
  const delta = inserted.length - removed.length;
  const contextFrom = Math.max(0, firstChanged - HUNK_CONTEXT_LINES);
  const contextTo = Math.min(starts.length - 1, lastChanged + HUNK_CONTEXT_LINES);
  const out: string[] = [];
  let cut = false;
  const clamp = (text: string): string => {
    if (text.length <= MAX_HUNK_LINE_CHARS) {
      return text;
    }
    cut = true;
    let end = MAX_HUNK_LINE_CHARS;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    return `${text.slice(0, end)}…`;
  };
  for (let at = contextFrom; at < firstChanged; at += 1) {
    const start = starts[at];
    if (start === undefined || start === before.length) {
      continue;
    }
    out.push(context(at + 1, clamp(lineText(before, starts, at))));
  }
  for (const [at, text] of removed.entries()) {
    out.push(mark('-', firstChanged + 1 + at, clamp(text)));
  }
  for (const [at, text] of inserted.entries()) {
    out.push(mark('+', firstChanged + 1 + at, clamp(text)));
  }
  for (let at = lastChanged + 1; at <= contextTo; at += 1) {
    const start = starts[at];
    if (start === undefined || start === before.length) {
      continue;
    }
    out.push(context(at + 1 + delta, clamp(lineText(before, starts, at))));
  }
  if (out.length <= MAX_HUNK_LINES) {
    return { lines: out, truncated: cut };
  }
  return { lines: out.slice(0, MAX_HUNK_LINES), truncated: true };
}


function mark(sign: '-' | '+', line: number, text: string): string {
  return `${sign} ${String(line).padStart(4)} ${text}`;
}

function context(line: number, text: string): string {
  return `  ${String(line).padStart(4)} ${text}`;
}

/** A line and column, both one-based, as a reader counts them. */
export interface Position {
  readonly line: number;
  readonly column: number;
}

/** Where an offset sits, as a line and a column in the text it was counted in. */
export function positionAt(text: string, offset: number): Position {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let start = 0;
  let newline = text.indexOf('\n');
  while (newline !== -1 && newline < clamped) {
    line += 1;
    start = newline + 1;
    newline = text.indexOf('\n', newline + 1);
  }
  return { line, column: clamped - start + 1 };
}
