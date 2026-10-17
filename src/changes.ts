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
}

interface Line {
  readonly start: number;
  readonly text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === '\n') {
      lines.push({ start, text: text.slice(start, at) });
      start = at + 1;
    }
  }
  lines.push({ start, text: text.slice(start) });
  return lines;
}

/** The index of the line an offset sits on, in the text the offset was counted in. */
function lineAt(lines: readonly Line[], offset: number): number {
  let index = 0;
  while (index + 1 < lines.length && (lines[index + 1]?.start ?? 0) <= offset) {
    index += 1;
  }
  return index;
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
  const change = diff(before, after);
  if (change.start === change.end && change.text === '') {
    return { lines: [], truncated: false };
  }
  const beforeLines = linesOf(before);
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
  const firstChanged = lineAt(beforeLines, from);
  const lastChanged = removed.length === 0 ? firstChanged - 1 : firstChanged + removed.length - 1;
  const delta = inserted.length - removed.length;
  const contextFrom = Math.max(0, firstChanged - HUNK_CONTEXT_LINES);
  const contextTo = Math.min(beforeLines.length - 1, lastChanged + HUNK_CONTEXT_LINES);
  const out: string[] = [];
  let cut = false;
  const clamp = (text: string): string => {
    if (text.length <= MAX_HUNK_LINE_CHARS) {
      return text;
    }
    cut = true;
    return `${text.slice(0, MAX_HUNK_LINE_CHARS)}…`;
  };
  for (let at = contextFrom; at < firstChanged; at += 1) {
    const line = beforeLines[at];
    if (line === undefined || isEnd(line, before)) {
      continue;
    }
    out.push(context(at + 1, clamp(line.text)));
  }
  for (const [at, text] of removed.entries()) {
    out.push(mark('-', firstChanged + 1 + at, clamp(text)));
  }
  for (const [at, text] of inserted.entries()) {
    out.push(mark('+', firstChanged + 1 + at, clamp(text)));
  }
  for (let at = lastChanged + 1; at <= contextTo; at += 1) {
    const line = beforeLines[at];
    if (line === undefined || isEnd(line, before)) {
      continue;
    }
    out.push(context(at + 1 + delta, clamp(line.text)));
  }
  if (out.length <= MAX_HUNK_LINES) {
    return { lines: out, truncated: cut };
  }
  return { lines: out.slice(0, MAX_HUNK_LINES), truncated: true };
}

/** The empty line a trailing newline leaves at the end of the text, which is not a line. */
function isEnd(line: Line, text: string): boolean {
  return line.start === text.length && line.text === '';
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
  for (let at = 0; at < clamped; at += 1) {
    if (text[at] === '\n') {
      line += 1;
      start = at + 1;
    }
  }
  return { line, column: clamped - start + 1 };
}
