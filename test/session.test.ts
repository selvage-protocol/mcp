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

  // A rename is the whole of the presence this seat publishes.
  await session.rename('somebody else');
  assert.equal(engine.calls.includes('rename somebody else'), true);
});
