/**
 * The wait against a stub engine: what it returns when the room moves, what it returns when the
 * room does not, and — the point of the whole thing — that a change landing between two waits is
 * reported by the next one rather than swallowed.
 *
 * Every wait here has a real deadline and every assertion is on what the wait returned. Nothing
 * sleeps and hopes; a wait that is expected to time out is given a deadline it cannot meet.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Session, SessionRefused } from '../src/session.ts';
import type { WaitReport } from '../src/session.ts';
import { StubEngine, StubFactory, peer } from './helpers/stub-engine.ts';

const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

/** A guest session over one stub engine, which is what most of these tests need. */
async function joined(engine: StubEngine): Promise<Session> {
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });
  return session;
}

/** The text a stub holds, as a room change the adapter would see. */
function fromRoom(engine: StubEngine, path: string, text: string): void {
  engine.remote(path, text);
  engine.emit({ type: 'documentChanged', path });
}

test('a wait returns on a room change as a hunk, with the length and not the whole document', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\ntwo\nthree\n']]),
  });
  const session = await joined(engine);
  // This seat's own edit is the watermark: the wait is about what the room did after it.
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  const waiting = session.waitForChange({ timeoutMs: 1_000 });
  fromRoom(engine, 'a.txt', 'ONE\nTWO\nthree\n');
  const report = await waiting;

  assert.equal(report.timedOut, false);
  assert.equal(report.ended, false);
  assert.equal(report.changes.length, 1);
  const change = report.changes[0];
  assert.equal(change?.path, 'a.txt');
  assert.equal(change?.kind, 'changed');
  assert.equal(change?.length, 'ONE\nTWO\nthree\n'.length);
  assert.deepEqual(change?.hunk, ['     1 ONE', '-    2 two', '+    2 TWO', '     3 three']);
  assert.equal(change?.truncated, false);
});

test('a wait that sees nothing returns at its deadline and says so, not that a change happened', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\n']]),
  });
  const session = await joined(engine);
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  const started = Date.now();
  const report = await session.waitForChange({ timeoutMs: 40 });

  assert.equal(report.timedOut, true);
  assert.equal(report.ended, false);
  assert.equal(report.timeoutMs, 40);
  assert.equal(report.changes.length, 0);
  assert.equal(report.watched, 1);
  assert.equal(report.documents, 1);
  assert.ok(Date.now() - started >= 30, 'the deadline is a real bound');
});

test('a change made between two waits is reported by the next one, not lost in the gap', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\ntwo\nthree\n']]),
  });
  const session = await joined(engine);
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  // The first wait reports nothing — the local edit is not a room change — and returns.
  const first = await session.waitForChange({ timeoutMs: 30 });
  assert.equal(first.timedOut, true);

  // The change lands while the agent is thinking: after the wait returned and before the next
  // call. The watermark is what keeps it, so the next wait has a hunk to give.
  fromRoom(engine, 'a.txt', 'ONE\nTWO\nthree\n');

  const second = await session.waitForChange({ timeoutMs: 30 });
  assert.equal(second.timedOut, false);
  assert.equal(second.changes.length, 1);
  assert.equal(second.changes[0]?.kind, 'changed');
  assert.deepEqual(second.changes[0]?.hunk, ['     1 ONE', '-    2 two', '+    2 TWO', '     3 three']);
});

test('a burst of frames while a wait is blocked arrives as one hunk of the final text', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\ntwo\n']]),
  });
  const session = await joined(engine);
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  const waiting = session.waitForChange({ timeoutMs: 1_000 });
  // One replacement arrives as two frames: the delete, then the insert. The wait must report the
  // room's final text once, not the half-deleted text between the frames.
  fromRoom(engine, 'a.txt', 'ONE\n\n');
  fromRoom(engine, 'a.txt', 'ONE\nTWO\n');
  const report = await waiting;

  assert.equal(report.changes.length, 1);
  assert.equal(report.changes[0]?.length, 'ONE\nTWO\n'.length);
  assert.deepEqual(report.changes[0]?.hunk, ['     1 ONE', '-    2 two', '+    2 TWO']);
});

test('a path that appears or disappears is said in words, with no hunk invented for it', async () => {
  const engine = new StubEngine({ listing: ['a.txt'], documents: [], texts: new Map() });
  const session = await joined(engine);

  fromRoom(engine, 'a.txt', 'new\n');
  const appeared = await session.waitForChange({ timeoutMs: 40 });
  assert.equal(appeared.changes.length, 1);
  assert.equal(appeared.changes[0]?.kind, 'appeared');
  assert.equal(appeared.changes[0]?.length, 4);
  assert.deepEqual(appeared.changes[0]?.hunk, []);

  engine.texts.delete('a.txt');
  engine.emit({ type: 'documentChanged', path: 'a.txt' });
  const gone = await session.waitForChange({ timeoutMs: 40 });
  assert.equal(gone.changes.length, 1);
  assert.equal(gone.changes[0]?.kind, 'disappeared');
  assert.deepEqual(gone.changes[0]?.hunk, []);
});

test('a report over its size bound says how many changes it left out, and they stay pending', async () => {
  const paths = Array.from({ length: 40 }, (_, at) => `p${String(at).padStart(2, '0')}.txt`);
  const bodies = paths.map(() =>
    Array.from({ length: 60 }, (_, at) => `line ${at}`).join('\n').concat('\n'),
  );
  const engine = new StubEngine({
    listing: paths,
    documents: paths,
    texts: new Map(paths.map((path, at) => [path, bodies[at] as string])),
  });
  const session = await joined(engine);

  // The first wait reports each document as an arrival, which is cheap, and takes the watermark.
  const first = await session.waitForChange({ timeoutMs: 100 });
  assert.equal(first.changes.length, 40);
  assert.ok(first.changes.every((change) => change.kind === 'appeared'));

  for (const [at, path] of paths.entries()) {
    fromRoom(engine, path, (bodies[at] as string).replaceAll('line', 'LINE'));
  }
  const second = await session.waitForChange({ timeoutMs: 100 });
  assert.ok(second.changes.length > 0, JSON.stringify(second));
  assert.ok(second.omitted > 0, `the bound did not bite: ${JSON.stringify({ shown: second.changes.length })}`);

  // What the bound left out was not marked reported: the next wait carries it, with no new change.
  const third = await session.waitForChange({ timeoutMs: 100 });
  assert.equal(third.timedOut, false);
  assert.ok(third.changes.length > 0, JSON.stringify(third));
});

test('a wait on named paths watches only those, and a change to the rest is not lost', async () => {
  const engine = new StubEngine({
    listing: ['a.txt', 'b.txt'],
    documents: ['a.txt', 'b.txt'],
    texts: new Map([
      ['a.txt', 'a\n'],
      ['b.txt', 'b\n'],
    ]),
  });
  const session = await joined(engine);
  await session.waitForChange({ timeoutMs: 100 });

  fromRoom(engine, 'b.txt', 'B\n');
  const ignored = await session.waitForChange({ paths: ['a.txt'], timeoutMs: 30 });
  assert.equal(ignored.timedOut, true);
  assert.equal(ignored.changes.length, 0);

  fromRoom(engine, 'a.txt', 'A\n');
  const seen = await session.waitForChange({ paths: ['a.txt'], timeoutMs: 30 });
  assert.equal(seen.timedOut, false);
  assert.deepEqual(seen.changes.map((change) => change.path), ['a.txt']);

  // `b.txt` was never marked reported by the narrow wait, so the wide one still owes it.
  const wide = await session.waitForChange({ timeoutMs: 30 });
  assert.deepEqual(wide.changes.map((change) => change.path), ['b.txt']);
});

test('a wait over the whole room reports a roster change, and a narrow wait does not', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'a\n']]),
  });
  const session = await joined(engine);
  await session.waitForChange({ timeoutMs: 100 });

  engine.peers = [peer('p1', 'dana', 'guest')];
  engine.emit({ type: 'peersChanged', peers: [...engine.peers] });
  const report = await session.waitForChange({ timeoutMs: 30 });
  assert.equal(report.peersChanged, true);
  assert.equal(report.participants, 2);

  engine.peers = [peer('p1', 'dana', 'guest'), peer('p2', 'heidi', 'guest')];
  engine.emit({ type: 'peersChanged', peers: [...engine.peers] });
  const narrow = await session.waitForChange({ paths: ['a.txt'], timeoutMs: 30 });
  assert.equal(narrow.timedOut, true);
  assert.equal(narrow.peersChanged, false);
});

test('a room that stops being live ends a wait early rather than leaving it to its deadline', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'a\n']]),
  });
  const session = await joined(engine);
  await session.waitForChange({ timeoutMs: 100 });

  const waiting = session.waitForChange({ timeoutMs: 5_000 });
  engine.emit({ type: 'disconnected' });
  const report: WaitReport = await waiting;
  assert.equal(report.ended, true);
  assert.equal(report.timedOut, false);
});

test('leaving under a held wait settles it at once, rather than at a deadline with no room', { timeout: 5_000 }, async () => {
  // The transport answers a leave while a wait is outstanding, which the read loop never used to
  // allow. The wait has to be settled by the leave: left to its clock it would re-read a session
  // that is gone, and the deadline callback is nobody's to catch.
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\n']]),
  });
  const session = await joined(engine);

  // A path the room holds no document for, so nothing is ready and the wait really blocks.
  const waiting = session.waitForChange({ paths: ['b.txt'], timeoutMs: 2_000 });
  const started = Date.now();
  await session.leave();
  const report: WaitReport = await waiting;

  assert.equal(report.ended, true, 'the session it was watching is gone');
  assert.equal(report.timedOut, false, 'a leave is not the deadline passing');
  assert.deepEqual(report.changes, []);
  assert.ok(Date.now() - started < 1_000, 'the leave settled the wait, not its own clock');
});

for (const trigger of ['settle', 'deadline'] as const) {
  test(`a blocked wait refuses malformed text at ${trigger} and retains its watermark`, { timeout: 5_000 }, async () => {
    const engine = new StubEngine({
      listing: ['a.txt'], documents: ['a.txt'], texts: new Map([['a.txt', 'before😀\n']]),
    });
    const session = await joined(engine);
    await session.waitForChange({ timeoutMs: 100 });
    const waiting = session.waitForChange({ timeoutMs: trigger === 'deadline' ? 40 : 1_000 });
    const rejected = assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof SessionRefused);
      assert.equal(error.code, 'bad-change');
      assert.match(error.message, /unpaired UTF-16 surrogate/);
      return true;
    });
    engine.remote('a.txt', 'bad\ud800\n');
    if (trigger === 'settle') {
      assert.doesNotThrow(() => engine.emit({ type: 'documentChanged', path: 'a.txt' }));
    }
    await rejected;
    await assert.rejects(session.waitForChange({ timeoutMs: 100 }), { name: 'SessionRefused', code: 'bad-change' });
    fromRoom(engine, 'a.txt', 'recovered😁\n');
    const report = await session.waitForChange({ timeoutMs: 100 });
    assert.deepEqual(report.changes[0]?.hunk, ['-    1 before😀', '+    1 recovered😁']);
    assert.equal((await session.waitForChange({ timeoutMs: 1 })).timedOut, true);
    await session.leave();
  });
}

test('a malformed path refuses a whole report without consuming other paths or the roster/listing', async () => {
  const engine = new StubEngine({
    listing: ['a.txt', 'b.txt'], documents: ['a.txt', 'b.txt'],
    texts: new Map([['a.txt', 'a😀\n'], ['b.txt', 'b😀\n']]),
  });
  const session = await joined(engine);
  await session.waitForChange({ timeoutMs: 100 });
  fromRoom(engine, 'a.txt', 'A😁\n');
  fromRoom(engine, 'b.txt', 'bad\udfff\n');
  engine.peers = [peer('p1', 'dana', 'guest')];
  engine.emit({ type: 'peersChanged', peers: [...engine.peers] });
  engine.emit({ type: 'grantChanged', paths: ['a.txt', 'b.txt'] });
  await assert.rejects(session.waitForChange({ timeoutMs: 100 }), { name: 'SessionRefused', code: 'bad-change' });
  fromRoom(engine, 'b.txt', 'B😁\n');
  const report = await session.waitForChange({ timeoutMs: 100 });
  assert.deepEqual(report.changes.map((change) => change.hunk), [
    ['-    1 a😀', '+    1 A😁'], ['-    1 b😀', '+    1 B😁'],
  ]);
  assert.equal(report.peersChanged, true);
  assert.equal(report.listingChanged, true);
});

test('a malformed arrival is refused and repair remains an arrival', async () => {
  const engine = new StubEngine({ listing: ['a.txt'], texts: new Map([['a.txt', '\ud800']]) });
  const session = await joined(engine);
  await assert.rejects(session.waitForChange({ timeoutMs: 100 }), { name: 'SessionRefused', code: 'bad-change' });
  fromRoom(engine, 'a.txt', '😀');
  const report = await session.waitForChange({ timeoutMs: 100 });
  assert.equal(report.changes[0]?.kind, 'appeared');
  assert.equal(report.changes[0]?.length, 2);
});
