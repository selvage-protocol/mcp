/**
 * The notification side: what a session tells its client without being asked, that it does so
 * only when a caller opted in, and that the transport's framing is one bounded message.
 *
 * The rate bound is checked against real time rather than a fake clock, because it is a bound on
 * a burst: several changes in one turn must come out as one message, not several.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { ActivityChannel } from '../src/notify.ts';
import { Session } from '../src/session.ts';
import type { Activity } from '../src/session.ts';
import type { JsonRpcNotification } from '../src/jsonrpc.ts';
import { StubEngine, StubFactory, peer } from './helpers/stub-engine.ts';

const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

function stub(text = 'one\ntwo\nthree\n'): StubEngine {
  return new StubEngine({
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', text]]),
  });
}

/** A guest session that announces room activity, with everything it announces collected. */
async function announcing(engine: StubEngine, activities: Activity[]): Promise<Session> {
  const session = new Session({
    engines: new StubFactory(engine),
    notify: (activity) => activities.push(activity),
  });
  await session.join({ invite: INVITE, displayName: 'agent', notifyChanges: true });
  return session;
}

function fromRoom(engine: StubEngine, path: string, text: string): void {
  engine.remote(path, text);
  engine.emit({ type: 'documentChanged', path });
}

test('the channel frames one activity as one notifications/message with structured data', () => {
  const channel = new ActivityChannel();
  const sent: JsonRpcNotification[] = [];
  channel.attach((message) => sent.push(message));

  channel.deliver({
    kind: 'document',
    path: 'a.txt',
    length: 4,
    hunk: ['-    1 one', '+    1 ONE'],
    truncated: false,
    appeared: false,
  });

  assert.deepEqual(sent, [
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: {
        level: 'info',
        logger: 'selvage',
        data: {
          selvage: 'document',
          path: 'a.txt',
          length: 4,
          appeared: false,
          truncated: false,
          hunk: ['-    1 one', '+    1 ONE'],
        },
      },
    },
  ]);
});

test('a client that asks for a higher level hears none of these info messages', () => {
  const channel = new ActivityChannel();
  const sent: JsonRpcNotification[] = [];
  channel.attach((message) => sent.push(message));
  const activity: Activity = {
    kind: 'peers',
    joined: ['dana'],
    left: [],
  };

  channel.setLevel('warning');
  channel.deliver(activity);
  assert.equal(sent.length, 0, 'a warning floor silences an info message');
  channel.setLevel('info');
  channel.deliver(activity);
  assert.equal(sent.length, 1, 'the level the message is at passes its own floor');
  channel.setLevel('debug');
  channel.deliver(activity);
  assert.equal(sent.length, 2);
});

test('a channel with no transport attached drops an activity rather than throwing', () => {
  const channel = new ActivityChannel();
  assert.doesNotThrow(() =>
    channel.deliver({ kind: 'document', path: 'a.txt', length: 0, hunk: [], truncated: false, appeared: true }),
  );
});

test('notifications are off unless the session was opened with them on', async () => {
  const engine = stub();
  const activities: Activity[] = [];
  const session = new Session({
    engines: new StubFactory(engine),
    notify: (activity) => activities.push(activity),
  });
  await session.join({ invite: INVITE, displayName: 'agent' });
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });
  fromRoom(engine, 'a.txt', 'ONE\nTWO\nthree\n');
  assert.deepEqual(activities, []);
});

test('a room change is announced as a bounded delta, and announcing it does not consume it', async () => {
  const engine = stub();
  const activities: Activity[] = [];
  const session = await announcing(engine, activities);
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  fromRoom(engine, 'a.txt', 'ONE\nTWO\nthree\n');

  assert.equal(activities.length, 1);
  const announced = activities[0];
  assert.equal(announced?.kind, 'document');
  if (announced?.kind !== 'document') {
    assert.fail('the announcement was not a document change');
  }
  assert.equal(announced.path, 'a.txt');
  assert.equal(announced.length, 'ONE\nTWO\nthree\n'.length);
  assert.equal(announced.appeared, false);
  assert.deepEqual(announced.hunk, ['     1 ONE', '-    2 two', '+    2 TWO', '     3 three']);

  // The notification is a second channel, not the wait: the wait still owes the same change.
  const report = await session.waitForChange({ timeoutMs: 30 });
  assert.equal(report.changes.length, 1);
  assert.deepEqual(report.changes[0]?.hunk, announced.hunk);
});

test('a document arriving is announced as an arrival with no hunk invented for it', async () => {
  const engine = new StubEngine({ listing: ['a.txt'], documents: [], texts: new Map() });
  const activities: Activity[] = [];
  await announcing(engine, activities);
  fromRoom(engine, 'a.txt', 'new\n');
  assert.equal(activities.length, 1);
  const announced = activities[0];
  assert.equal(announced?.kind, 'document');
  assert.equal(announced?.kind === 'document' ? announced.appeared : undefined, true);
  assert.deepEqual(announced?.kind === 'document' ? announced.hunk : undefined, []);
});

test('peers joining and leaving are announced by name, bounded to a handful', async () => {
  const engine = stub();
  const activities: Activity[] = [];
  await announcing(engine, activities);

  engine.peers = [peer('p1', 'dana', 'guest')];
  engine.emit({ type: 'peersChanged', peers: [...engine.peers] });
  engine.peers = [];
  engine.emit({ type: 'peersChanged', peers: [...engine.peers] });

  assert.deepEqual(activities, [
    { kind: 'peers', joined: ['dana'], left: [] },
    { kind: 'peers', joined: [], left: ['dana'] },
  ]);
});

test('one path cannot storm the client: a burst is one message per window', async () => {
  const engine = stub();
  const activities: Activity[] = [];
  const session = await announcing(engine, activities);
  await session.edit('a.txt', { start: 0, end: 3, text: 'ONE' });

  for (let at = 0; at < 5; at += 1) {
    fromRoom(engine, 'a.txt', `ONE\nchange ${at}\n`);
  }
  assert.equal(activities.length, 1, JSON.stringify(activities));
});

test('the whole client cannot be stormed either: a window holds at most twenty messages', async () => {
  const paths = Array.from({ length: 40 }, (_, at) => `p${String(at).padStart(2, '0')}.txt`);
  const engine = new StubEngine({
    listing: paths,
    documents: [],
    texts: new Map(),
  });
  const activities: Activity[] = [];
  await announcing(engine, activities);

  for (const path of paths) {
    fromRoom(engine, path, 'first\n');
  }
  assert.ok(activities.length <= 20, `a window let ${activities.length} through`);
  assert.ok(activities.length > 0);
});

test('malformed notifications keep both baselines and the rate window for valid recovery', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const engine = stub('before😀\n');
  const activities: Activity[] = [];
  const session = await announcing(engine, activities);
  await session.waitForChange({ timeoutMs: 100 });
  fromRoom(engine, 'a.txt', 'announced😁\n');
  assert.equal(activities.length, 1);
  now += 501;
  for (const malformed of ['bad\ud800\n', 'bad\udfff\n', 'bad\udfff\n']) {
    assert.doesNotThrow(() => fromRoom(engine, 'a.txt', malformed));
    assert.equal(activities.length, 1, 'malformed content was not announced');
    assert.equal(engine.text('a.txt'), malformed, 'refusal did not normalize the replica');
  }
  assert.equal(session.status().problems.at(-1)?.cause, 'bad-change');
  await assert.rejects(session.waitForChange({ timeoutMs: 100 }), { name: 'SessionRefused', code: 'bad-change' });
  fromRoom(engine, 'a.txt', 'recovered😀\n');
  assert.equal(activities.length, 2, 'refusal did not consume the notification rate window');
  const recovered = activities[1];
  assert.equal(recovered?.kind, 'document');
  assert.deepEqual(recovered?.kind === 'document' ? recovered.hunk : undefined, [
    '-    1 announced😁', '+    1 recovered😀',
  ]);
  const report = await session.waitForChange({ timeoutMs: 100 });
  assert.deepEqual(report.changes[0]?.hunk, ['-    1 before😀', '+    1 recovered😀']);
});

test('a malformed notification arrival refuses without losing the later valid arrival', async () => {
  const engine = new StubEngine({ listing: ['a.txt'] });
  const activities: Activity[] = [];
  const session = await announcing(engine, activities);
  assert.doesNotThrow(() => fromRoom(engine, 'a.txt', '\ud800'));
  assert.deepEqual(activities, []);
  fromRoom(engine, 'a.txt', '😀');
  assert.deepEqual(activities, [{
    kind: 'document', path: 'a.txt', length: 2, hunk: [], truncated: false, appeared: true,
  }]);
  const report = await session.waitForChange({ timeoutMs: 100 });
  assert.equal(report.changes[0]?.kind, 'appeared');
});
