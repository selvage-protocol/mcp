/**
 * The session an agent drives, against a stub engine: the state it holds, what it refuses, the
 * edit path and the invite round trip. The real file system gets its own file
 * (`session-grant.test.ts`) — this one is about the adapter's own decisions.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Session, SessionRefused } from '../src/session.ts';
import type { SessionRefusal } from '../src/session.ts';
import { StubEngine, StubFactory, peer } from './helpers/stub-engine.ts';
import { put, remove, scratch } from './helpers/scratch.ts';
import { until } from './helpers/until.ts';

/** A link of the shape §5.1 writes: the page's or the wire's, with both keys in the fragment. */
const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

/** An assertion that a rejection is this refusal and no other. */
function refused(code: SessionRefusal): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof SessionRefused, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

test('a session with no room refuses every question and every act', async () => {
  const session = new Session({ engines: new StubFactory() });
  assert.equal(session.hasSession(), false);
  assert.throws(() => session.status(), refused('no-session'));
  assert.throws(() => session.grantedPaths(), refused('no-session'));
  assert.throws(() => session.participants(), refused('no-session'));
  assert.throws(() => session.inviteUrl(), refused('no-session'));
  await assert.rejects(session.read('a.txt'), refused('no-session'));
  await assert.rejects(session.write('a.txt', 'x'), refused('no-session'));
  await assert.rejects(session.edit('a.txt', { start: 0, end: 0, text: 'x' }), refused('no-session'));
  await assert.rejects(session.leave(), refused('no-session'));
  await assert.rejects(session.rename('someone'), refused('no-session'));
});

test('hosting hands the folder to the engine, reports the room and answers with the invite', async () => {
  const root = await scratch('host');
  try {
    await put(root, 'a.txt', 'one\n');
    await put(root, 'src/kept.txt', 'two\n');
    await put(root, 'ignored.txt', 'ignored by the folder\n');
    await put(root, '.gitignore', 'ignored.txt\n');
    await put(root, 'node_modules/dep/index.js', 'excluded by name\n');
    await put(root, '.git/config', 'excluded by name\n');
    await put(root, 'excluded.txt', 'excluded by the repository\n');
    await put(root, '.git/info/exclude', 'excluded.txt\n');

    const engine = new StubEngine({ role: 'host', invite: INVITE });
    const factory = new StubFactory(engine);
    const session = new Session({ engines: factory });
    const hosted = await session.host({
      root,
      serverUrl: 'http://room.example',
      displayName: 'agent',
    });

    assert.equal(hosted.roomId, 'room-1');
    assert.equal(hosted.role, 'host');
    assert.equal(hosted.inviteUrl, INVITE);
    // The walk's own listing, sorted, with the excludes, the ignore file and the repository
    // exclude all applied — and nothing above the folder read (`core.excludesFile` is not asked).
    assert.deepEqual(hosted.paths, ['.gitignore', 'a.txt', 'src/kept.txt']);
    assert.equal(hosted.cut, undefined);
    // The listing was in the engine's hands before the room was minted, and the base was read
    // in the one spelling the engine dials.
    assert.deepEqual(factory.hosted[0]?.listing.current(), ['.gitignore', 'a.txt', 'src/kept.txt']);
    assert.equal(factory.hosted[0]?.baseUrl, 'ws://room.example');
    assert.equal(session.status().live, true);
    // The room's listing is the engine's answer, and a host's engine is the one this walk fed.
    engine.listing = hosted.paths;
    assert.deepEqual(session.grantedPaths(), ['.gitignore', 'a.txt', 'src/kept.txt']);
  } finally {
    await remove(root);
  }
});

test('a server address the engine cannot dial is refused before anything is opened', async () => {
  const session = new Session({ engines: new StubFactory() });
  await assert.rejects(
    session.host({ root: '.', serverUrl: 'not a url', displayName: 'agent' }),
    refused('not-a-server'),
  );
  assert.equal(session.hasSession(), false);
});

test('a host the engine will not open is refused, without the address it was dialled at', async () => {
  const root = await scratch('host-refused');
  try {
    await put(root, 'a.txt', 'one\n');
    const address = 'ws://room.example';
    const factory = new StubFactory();
    factory.hostError = new Error(`the socket to ${address} did not open`);
    const session = new Session({ engines: factory });

    await assert.rejects(
      session.host({ root, serverUrl: address, displayName: 'agent' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRefused);
        assert.equal(error.code, 'host-failed');
        assert.equal(error.message, 'the socket to [address] did not open');
        return true;
      },
    );
    assert.equal(session.hasSession(), false, 'a host that never came up holds nothing');

    // An invite handed where an address belongs is a link with a key in its fragment, and this
    // refusal is prose a caller may log: no part of it is repeated back.
    await assert.rejects(
      session.host({ root, serverUrl: INVITE, displayName: 'agent' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRefused);
        assert.equal(error.code, 'not-a-server');
        assert.doesNotMatch(error.message, /#k=/);
        assert.doesNotMatch(error.message, /a{43}/);
        assert.match(error.message, /\[address\]/);
        return true;
      },
    );
  } finally {
    await remove(root);
  }
});

test('a second host or join is refused, naming the live session, and leaving frees the process', async () => {
  const root = await scratch('busy');
  try {
    await put(root, 'a.txt', 'one\n');
    const factory = new StubFactory(new StubEngine({ role: 'host', invite: INVITE }));
    const session = new Session({ engines: factory });
    await session.host({ root, serverUrl: 'ws://room.example', displayName: 'agent' });

    await assert.rejects(
      session.host({ root, serverUrl: 'ws://room.example', displayName: 'agent' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRefused);
        assert.equal(error.code, 'busy');
        assert.match(error.message, /room-1/);
        return true;
      },
    );
    await assert.rejects(
      session.join({ invite: INVITE, displayName: 'agent' }),
      refused('busy'),
    );
    // The two refusals opened nothing: the first room is still the one this process holds.
    assert.equal(factory.hosted.length, 1);
    assert.equal(factory.joined.length, 0);

    await session.leave();
    assert.equal(session.hasSession(), false);
    assert.throws(() => session.status(), refused('no-session'));
    // A host's leave ends the room for every seat, and then ends this connection.
    assert.deepEqual(factory.hostResult?.calls.slice(-2), ['closeRoom', 'disconnect']);
    assert.equal(factory.hostResult?.connected, false);

    factory.joinResult = new StubEngine({ roomId: 'room-2', listing: ['a.txt'] });
    const joined = await session.join({ invite: INVITE, displayName: 'agent' });
    assert.equal(joined.roomId, 'room-2');
  } finally {
    await remove(root);
  }
});

test('joining hands the engine the whole link and reports the room, the role and the grant', async () => {
  const engine = new StubEngine({
    roomId: 'room-9',
    role: 'guest',
    listing: ['a.txt', 'src/b.txt'],
    documents: ['a.txt'],
  });
  const factory = new StubFactory(engine);
  const session = new Session({ engines: factory });
  const joined = await session.join({ invite: `  ${INVITE}  `, displayName: 'agent' });

  // The fragment is what makes the link a key rather than an address, so it is handed on whole.
  assert.equal(factory.joined[0]?.invite, INVITE);
  assert.equal(factory.joined[0]?.displayName, 'agent');
  assert.equal(joined.roomId, 'room-9');
  assert.equal(joined.role, 'guest');
  assert.deepEqual(joined.paths, ['a.txt', 'src/b.txt']);
  assert.equal(joined.pathCount, 2);
  // A joiner has no invite of its own: it was invited.
  assert.equal(session.inviteUrl(), undefined);
  assert.equal(session.status().documents.length, 1);
});

test('a refusal read back from an invite carries no fragment', async () => {
  const factory = new StubFactory();
  factory.joinError = new Error(`could not dial ${INVITE}: the room is gone`);
  const session = new Session({ engines: factory });

  await assert.rejects(
    session.join({ invite: INVITE, displayName: 'agent' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionRefused);
      assert.equal(error.code, 'join-failed');
      assert.doesNotMatch(error.message, /#k=/);
      assert.doesNotMatch(error.message, /a{43}/);
      assert.match(error.message, /\[invite\]/);
      return true;
    },
  );
  assert.equal(session.hasSession(), false);
});

test('a join asked for with nothing to dial reads back as the failure it was', async () => {
  const factory = new StubFactory();
  factory.joinError = new Error('nothing to dial');
  const session = new Session({ engines: factory });

  // An invite of nothing is what an empty or whitespace `invite` trims to, and there is no key
  // in it to take out: a masking that split on the empty string would put `[invite]` between
  // every character of the message instead.
  await assert.rejects(
    session.join({ invite: '   ', displayName: 'agent' }),
    (error: unknown) => {
      assert.ok(error instanceof SessionRefused);
      assert.equal(error.code, 'join-failed');
      assert.equal(error.message, 'nothing to dial');
      return true;
    },
  );
  assert.equal(session.hasSession(), false);
});

test('participants carry the room\'s names and roles, and awareness only where it was published', async () => {
  const ada = peer('p-ada', 'ada', 'host', 7);
  const engine = new StubEngine({
    self: peer('p-self', 'agent', 'guest'),
    peers: [ada],
    presence: [{ clientId: 7, peer: ada, state: { path: 'a.txt' } }],
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  assert.deepEqual(session.participants(), [
    { peerId: 'p-self', displayName: 'agent', role: 'guest', aware: false, self: true },
    { peerId: 'p-ada', displayName: 'ada', role: 'host', aware: true, self: false },
  ]);
  // Identity is published and a cursor is not: the only awareness call a session makes is none.
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('setSelection')), []);
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('setAwareness')), []);
});

test('a listing that never arrived is recorded, not answered as an empty room', async () => {
  // A guest that opened with no documents and no listing: through this interface an empty folder
  // and a listing still on its way are the same absent number, and the wait is what tells them
  // apart. The wait ending is a fact about the join, so it is kept rather than dropped.
  const engine = new StubEngine({ role: 'guest' });
  const session = new Session({ engines: new StubFactory(engine), grantWaitMs: 20 });

  const joined = await session.join({ invite: INVITE, displayName: 'agent' });
  assert.deepEqual(joined.paths, []);
  assert.equal(joined.pathCount, 0);

  const problems = session.status().problems;
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0]?.cause, 'timed-out');
  assert.match(problems[0]?.message ?? '', /20 ms/);
  // And a listing that did arrive is not recorded: an empty folder is not a problem.
  engine.listing = ['a.txt'];
  const listed = new Session({ engines: new StubFactory(new StubEngine({ listing: ['a.txt'] })) });
  await listed.join({ invite: INVITE, displayName: 'agent' });
  assert.deepEqual(listed.status().problems, []);
});

test('an edit is published as the replica\'s difference, and the hold is given up', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one two\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  const outcome = await session.edit('a.txt', { start: 0, end: 3, text: '1' });

  assert.equal(engine.text('a.txt'), '1 two\n');
  assert.equal(outcome.path, 'a.txt');
  assert.equal(outcome.length, 6);
  // A guest writes nothing: there is no mirror and no folder of its own.
  assert.equal(outcome.disk, 'none');
  assert.deepEqual(
    engine.calls.filter((call) => /^(insert|delete) /.test(call)),
    ['delete a.txt 0 3', 'insert a.txt 0 "1"'],
  );
  assert.deepEqual(
    engine.calls.filter((call) => /^(open|close) /.test(call)),
    ['open a.txt', 'close a.txt'],
  );
});

test('a write replaces the text through the same local-change path', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'old\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  const outcome = await session.write('a.txt', 'new\r\ntext\r\n');

  // The replica is LF-only, whoever wrote it (`toCrdt`).
  assert.equal(engine.text('a.txt'), 'new\ntext\n');
  assert.equal(outcome.length, 9);
});

test('a viewer\'s edit is refused before the document is even opened', async () => {
  const engine = new StubEngine({
    role: 'viewer',
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(session.edit('a.txt', { start: 0, end: 0, text: 'x' }), refused('read-only'));
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('open')), []);
});

test('a change that does not fit the replica is refused, and the hold is given up', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(
    session.edit('a.txt', { start: 1, end: 99, text: 'x' }),
    refused('bad-change'),
  );
  assert.equal(engine.text('a.txt'), 'one\n');
  assert.deepEqual(
    engine.calls.filter((call) => /^(insert|delete) /.test(call)),
    [],
  );
  assert.equal(engine.calls.includes('close a.txt'), true);
});

test('an edit of a path the grant would never name is refused', async () => {
  const engine = new StubEngine({ listing: ['.git/config'] });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(session.write('.git/config', 'x'), refused('not-granted'));
  await assert.rejects(session.write('../outside.txt', 'x'), refused('not-granted'));
});

test('a write over the bytes a session carries is refused before anything is opened', async () => {
  const engine = new StubEngine({ listing: ['a.txt'] });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(session.write('a.txt', 'x'.repeat(1024 * 1024 + 1)), refused('too-large'));
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('open')), []);
});

test('a read takes a hold, answers with the room\'s text and gives the hold up', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    onOpen: (path, stub) => {
      stub.remote(path, 'hello\n');
      stub.emit({ type: 'documentChanged', path });
    },
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  const read = await session.read('a.txt');
  assert.deepEqual(read, { path: 'a.txt', text: 'hello\n' });
  assert.deepEqual(
    engine.calls.filter((call) => /^(open|close) /.test(call)),
    ['open a.txt', 'close a.txt'],
  );
});

test('a read of a path outside the room\'s listing is refused, and nothing is opened', async () => {
  const engine = new StubEngine({ listing: ['a.txt'] });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(session.read('b.txt'), refused('not-granted'));
  await assert.rejects(session.read('/etc/passwd'), refused('not-granted'));
  await assert.rejects(session.read('../a.txt'), refused('not-granted'));
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('open')), []);
});

test('a read the room never answers ends at its deadline, saying what it saw', async () => {
  const engine = new StubEngine({ listing: ['a.txt'] });
  const session = new Session({
    engines: new StubFactory(engine),
    documentWaitMs: 50,
  });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(
    session.read('a.txt'),
    (error: unknown) => {
      assert.ok(error instanceof SessionRefused);
      assert.equal(error.code, 'timed-out');
      assert.match(error.message, /50 ms/);
      return true;
    },
  );
  assert.equal(engine.calls.includes('close a.txt'), true);
});

/**
 * The second half of the same wait. A connection whose key no state commits publishes nothing but
 * its announcement (`§13.1`'s step 4) — the hold it just took included — so the room has not been
 * asked for the document and owes no answer to it. `§7.1` lets the host that folds that
 * announcement into its publish window take a whole `awareness_renew_ms` to send the state that
 * commits the seat, and the document follows that state: a wait that starts on the document's own
 * deadline instead refuses a hold the room would have answered.
 */
test('a read waits for the room to commit this seat before it times the document out', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    committed: false,
    keepalive: { ping_interval_ms: 100, awareness_renew_ms: 200, awareness_expire_ms: 400 },
    onOpen: (path, stub) => {
      setTimeout(() => {
        stub.committed = true;
        stub.remote(path, 'from the room\n');
        stub.emit({ type: 'documentChanged', path });
      }, 120);
    },
  });
  const session = new Session({ engines: new StubFactory(engine), documentWaitMs: 50 });
  await session.join({ invite: INVITE, displayName: 'agent' });

  const read = await session.read('a.txt');
  assert.deepEqual(read, { path: 'a.txt', text: 'from the room\n' });
  assert.deepEqual(
    engine.calls.filter((call) => /^(open|close) /.test(call)),
    ['open a.txt', 'close a.txt'],
  );
});

/**
 * The wait for the seat is bounded by the room's own clock and says which wait expired: a room
 * that never commits this connection must not hold a read open for ever, and the sentence has to
 * name what was missing rather than reporting the document's deadline for it.
 */
test('a seat the room never commits gives up on the room\'s clock, not the document\'s', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    committed: false,
    keepalive: { ping_interval_ms: 100, awareness_renew_ms: 200, awareness_expire_ms: 400 },
  });
  const session = new Session({ engines: new StubFactory(engine), documentWaitMs: 20 });
  await session.join({ invite: INVITE, displayName: 'agent' });

  await assert.rejects(
    session.read('a.txt'),
    (error: unknown) => {
      assert.ok(error instanceof SessionRefused);
      assert.equal(error.code, 'timed-out');
      assert.match(error.message, /1200 ms/);
      assert.match(error.message, /awareness_renew_ms/);
      return true;
    },
  );
  assert.equal(engine.calls.includes('close a.txt'), true);
});

test('the room\'s own events are what the session reports about itself', async () => {
  const engine = new StubEngine({ listing: ['a.txt'] });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });
  assert.equal(session.status().live, true);

  engine.emit({ type: 'reconnecting' });
  assert.equal(session.status().live, false);
  engine.emit({ type: 'peersChanged', peers: [] });
  assert.equal(session.status().live, true);
  engine.emit({ type: 'roomGone', reason: 'the host left' });
  assert.equal(session.status().live, false);

  // A rename is the identity this seat publishes; the cursor is the other half, and only when
  // the session was opened for it.
  await session.rename('somebody else');
  assert.equal(engine.calls.includes('rename somebody else'), true);
});

/**
 * The cursor, which is off unless the session asks for it. A read names the start of the file
 * because that is the only place a read can honestly point at, and an edit names the end of the
 * range it changed, which is where the edit happened.
 */
test('a read with the cursor on publishes a caret at the start of the file', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'hello\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent', publishCursor: true });

  await session.read('a.txt');

  assert.deepEqual(
    engine.calls.filter((call) => call.startsWith('setSelection')),
    ['setSelection a.txt 0..0'],
  );
});

test('an edit with the cursor on publishes the end of the range it changed', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one two\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent', publishCursor: true });

  await session.edit('a.txt', { start: 0, end: 3, text: '1' });

  // `one` became `1`, so the change is [0, 1) and the caret lands at its end.
  assert.deepEqual(
    engine.calls.filter((call) => call.startsWith('setSelection')),
    ['setSelection a.txt 1..1'],
  );
});

test('a write with the cursor on publishes the end of the range it changed', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'old\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent', publishCursor: true });

  await session.write('a.txt', 'new\n');

  // `old` became `new`: the smallest change is [0, 3), and the caret lands at its end.
  assert.deepEqual(
    engine.calls.filter((call) => call.startsWith('setSelection')),
    ['setSelection a.txt 3..3'],
  );
});

test('a published cursor is renewed on the room\'s clock and stops when the session ends', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'hello\n']]),
    keepalive: { ping_interval_ms: 1_000, awareness_renew_ms: 25, awareness_expire_ms: 50 },
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent', publishCursor: true });
  await session.read('a.txt');

  const published = (): number =>
    engine.calls.filter((call) => call === 'setSelection a.txt 0..0').length;
  assert.equal(published(), 1, 'the read published once');
  // The room advertises a 25 ms renewal window, so a 2 s deadline is eighty of them: three
  // publishes cannot be the one the read made.
  await until('the cursor to be renewed more than once', published, (count) => count >= 3, 2_000);

  await session.leave();
  const atLeave = published();
  assert.equal(engine.calls.includes('setAwareness null'), true, 'leaving left the caret behind');
  // Seven windows with no renewal: a timer that outlived the leave would have published again.
  await new Promise((settle) => setTimeout(settle, 175));
  assert.equal(published(), atLeave, 'the renewal outlived the session');
});

test('with the cursor off a read and an edit publish nothing at all', async () => {
  const engine = new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one two\n']]),
  });
  const session = new Session({ engines: new StubFactory(engine) });
  await session.join({ invite: INVITE, displayName: 'agent' });
  await session.read('a.txt');
  await session.edit('a.txt', { start: 0, end: 3, text: '1' });
  await session.leave();

  assert.deepEqual(
    engine.calls.filter(
      (call) => call.startsWith('setSelection') || call.startsWith('setAwareness'),
    ),
    [],
  );
});
