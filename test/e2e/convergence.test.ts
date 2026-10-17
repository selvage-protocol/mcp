/**
 * The end-to-end proof: two Model Context Protocol servers, each a real process over its own
 * stdio, editing one room through a real `selvaged`.
 *
 * Nothing here is stubbed. The host shares a folder it holds under `.tmp/`, the guest joins the
 * invite link the host handed back — fragment and all — and the two converge in both
 * directions: the guest's edit reaches the host's room and the host's own working copy, and the
 * host's write reaches a file the guest reads. Every assertion is on converged content, never on
 * the absence of an error, and a step that stalls says which one it was.
 *
 * The server binary is required, not optional: a proof that skips itself is not a proof.
 */

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { put, scratch } from '../helpers/scratch.ts';
import { RealSelvaged, selvagedBinary } from '../helpers/selvaged.ts';
import { StdioServer, type SpawnOptions } from '../helpers/stdio-client.ts';
import { until } from '../helpers/until.ts';

/** The deadline a single step has, and the whole proof's own bound. */
const STEP_MS = 20_000;

/** One MCP server process, called the way a client calls it. */
class Tool {
  private nextId = 1;
  private readonly label: string;
  private readonly server: StdioServer;

  private constructor(label: string, server: StdioServer) {
    this.label = label;
    this.server = server;
  }

  static async start(t: TestContext, label: string, options: SpawnOptions): Promise<Tool> {
    const server = StdioServer.start(options);
    t.after(() => server.stop());
    const tool = new Tool(label, server);
    server.send({
      jsonrpc: '2.0',
      id: tool.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: label, version: '1' },
      },
    });
    await server.nextResult(1, `${label}'s initialize result`);
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return tool;
  }

  /** One `tools/call`, returning what it answered in band — a refusal included. */
  async raw(
    name: string,
    args: Record<string, unknown> = {},
    ms: number = STEP_MS,
  ): Promise<string> {
    const id = this.nextId++;
    this.server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const result = (await this.server.nextResult(id, `${name} on ${this.label}`, ms)) as {
      readonly content?: readonly { readonly text?: string }[];
      readonly isError?: boolean;
    };
    const text = (result.content ?? []).map((block) => block.text ?? '').join('');
    return result.isError === true ? `refused: ${text}` : text;
  }

  /** One `tools/call` that has to work. */
  async call(name: string, args: Record<string, unknown> = {}, ms: number = STEP_MS): Promise<string> {
    const text = await this.raw(name, args, ms);
    assert.ok(!text.startsWith('refused: '), `${name} on ${this.label} failed: ${text}`);
    return text;
  }

  /** Everything this server has written, for a failure message. */
  report(): string {
    return `${this.label}: ${this.server.report()}`;
  }
}

function roomIdOf(hosted: string): string {
  const match = /^hosting room (\S+) as (\S+),/.exec(hosted);
  assert.ok(match !== null, `session_host answered something else: ${hosted}`);
  return match[1] as string;
}

function inviteOf(hosted: string): string {
  const match = /^invite: (\S+)$/m.exec(hosted);
  assert.ok(match !== null, `session_host answered no invite URL: ${hosted}`);
  return match[1] as string;
}

test('two MCP servers converge on one room through a real selvaged', { timeout: STEP_MS * 2 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-host');
  const guestFolder = await scratch('e2e-guest');
  const before = 'ada types here\n';
  await put(hostFolder, 'a.txt', before);
  await put(hostFolder, 'b.txt', 'the host holds this\n');

  // The host process names no server address of its own: it reads `SELVAGE_SERVER_URL`, which is
  // the configuration a client writes down.
  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const room = roomIdOf(hosted);
  const invite = inviteOf(hosted);
  assert.ok(invite.includes('#'), `the invite carries no fragment: ${invite}`);

  const joined = await guest.call('session_join', { invite });
  assert.match(joined, /^joined room \S+ as guest,/, `the guest is not a guest: ${joined}`);
  assert.ok(joined.includes(room), `the guest joined another room: ${joined}`);

  // Presence converges before anything is edited: the host sees both seats.
  await until(
    'the host to see the guest',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // Guest -> host: an edit of a shared file reaches the host's room and its working copy.
  await guest.call('edit_file', { path: 'a.txt', old_string: 'ada', new_string: 'grace' });
  const after = 'grace types here\n';
  const seen = await until(
    "the guest's edit to reach the host",
    () => host.raw('read_file', { path: 'a.txt' }),
    (text) => text === after,
    STEP_MS,
  );
  assert.equal(seen, after);
  // The folder's own copy is a second, later thing: the room's event starts the write-back and
  // nothing waits for it, so this waits for the folder rather than reading it once — and the
  // wait still fails if the folder never follows, naming what was on disk when it gave up.
  const onDisk = await until(
    "the host's own folder to follow the room",
    () => readFile(join(hostFolder, 'a.txt'), 'utf8'),
    (text) => text === after,
    STEP_MS,
  );
  assert.equal(onDisk, after);

  // Host -> guest: a write reaches a file the guest has no copy of.
  const published = 'the host published this\n';
  await host.call('write_file', { path: 'b.txt', content: published });
  const read = await until(
    "the host's write to reach the guest",
    () => guest.raw('read_file', { path: 'b.txt' }),
    (text) => text === published,
    STEP_MS,
  );
  assert.equal(read, published);

  // The guest writes nothing of its own, and lists what the host shared.
  assert.deepEqual(await readdir(guestFolder), [], 'the guest wrote to its own disk');
  const listing = await guest.call('list_paths');
  assert.match(listing, /^a\.txt$/m);
  assert.match(listing, /^b\.txt$/m);
});

/**
 * A host's own first read of a shared path, with a guest in the room. The read takes a hold, and
 * the room answering that it now holds the path is the event that seeds it — while the read itself
 * is seeding the same path from the folder. Both insert the whole file unless one seed is
 * remembered as in flight, and the room then holds the file's text twice. Nothing here edits
 * anything: the doubling was observed in a live session before any edit succeeded, and the first
 * edit refused was refused because the document already held its text twice.
 */
test('a host holds a shared path once when its own read seeds it', { timeout: STEP_MS * 2 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-seed-host');
  const guestFolder = await scratch('e2e-seed-guest');
  const body = 'FizzBuzz, with one branch\nsecond line here\n';
  const paths = ['one.txt', 'two.txt', 'three.txt'];
  for (const path of paths) {
    await put(hostFolder, path, body);
  }

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const room = roomIdOf(hosted);
  const joined = await guest.call('session_join', { invite: inviteOf(hosted) });
  assert.ok(joined.includes(room), `the guest joined another room: ${joined}`);
  await until(
    'the host to see the guest',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // Nothing has opened these paths, so the room holds no document for them: the first read is
  // the read that meets the hold's own echo. Each answer is the whole assertion — a room holding
  // the file twice answers with it twice — and the second pass reads back what the first left.
  for (const path of paths) {
    const text = await host.call('read_file', { path });
    assert.equal(text, body, `the room holds ${path} as something other than the file text`);
  }
  for (const path of paths) {
    assert.equal(await host.call('read_file', { path }), body, `the room multiplied ${path}`);
  }
});


/**
 * The other shape that asks for one document twice: a **guest** reading a path the room has not
 * delivered, with the host reading it too. A guest's read is a hold, and a hold on a path nothing
 * has arrived for is what makes the host seed it — so the guest's ask and the host's own ask are
 * the room's two callers of one seed, and either order of them has to leave one copy. The live
 * session this came from had two seats besides the host, so a third seat does the counting here:
 * its read is never the ask that seeds anything, because the document is in the room by then.
 *
 * The last path is asked for by both at once, which is the window a seed is in flight for. Every
 * assertion is the whole text and the number of times it appears: a room holding it twice answers
 * with it twice, and the folder follows the room.
 */
test('a guest\'s read and the host\'s own read of one path leave it once', { timeout: STEP_MS * 2 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-ask-host');
  const guestFolder = await scratch('e2e-ask-guest');
  const otherFolder = await scratch('e2e-ask-other');
  const body = 'FizzBuzz, with one branch\nsecond line here\n';
  const paths = ['one.txt', 'two.txt', 'three.txt'];
  for (const path of paths) {
    await put(hostFolder, path, body);
  }

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });
  const other = await Tool.start(t, 'other', {
    cwd: otherFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'heidi' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const room = roomIdOf(hosted);
  const invite = inviteOf(hosted);
  for (const seat of [guest, other]) {
    const joined = await seat.call('session_join', { invite });
    assert.ok(joined.includes(room), `a seat joined another room: ${joined}`);
  }
  await until(
    'the host to see three seats',
    () => host.raw('session_status'),
    (text) => /^participants: 3$/m.test(text),
    STEP_MS,
  );

  // The guest asks first and the host asks after: the room's event seeds for the guest's hold, and
  // the host's own read is the second ask for the same document.
  await guest.call('read_file', { path: 'one.txt' });
  assert.equal(await host.call('read_file', { path: 'one.txt' }), body, 'the host read something else');

  // The host asks first, and a guest asks after: the host's own read is the seed, and the guest's
  // hold arrives while the room already has the text.
  assert.equal(await host.call('read_file', { path: 'two.txt' }), body, 'the host read something else');
  assert.equal(await guest.call('read_file', { path: 'two.txt' }), body, 'the guest read something else');

  // Both at once, which is the window the seed's folder read is open for.
  const both = await Promise.all([
    host.call('read_file', { path: 'three.txt' }),
    guest.call('read_file', { path: 'three.txt' }),
  ]);
  for (const text of both) {
    assert.equal(text, body, 'a concurrent read answered with something else');
  }

  // What the room holds, read by a seat that never asked for any of it, and what the folder holds.
  for (const path of paths) {
    const inRoom = await other.call('read_file', { path });
    assert.equal(inRoom, body, `the room holds ${path} as something other than the file text`);
    assert.equal(
      inRoom.split(body).length - 1,
      1,
      `the room holds ${path} ${inRoom.split(body).length - 1} times`,
    );
    const onDisk = await readFile(join(hostFolder, path), 'utf8');
    assert.equal(onDisk, body, `the host's folder holds ${path} as something else`);
  }
});

/**
 * The room's **second** joiner, opening a path the host had already seeded before it arrived.
 *
 * `§13.1`'s step 4 leaves a connection whose key no state commits able to publish nothing but its
 * announcement: the hold it takes on the path has not reached the room, and the `SyncStep1` that
 * asks the room for what this replica lacks has not gone out — so nothing has been asked for,
 * however much the room holds. `§7.1` lets a host fold that announcement into the publish window
 * the state answering an earlier one opened, which is one `awareness_renew_ms` — fifteen seconds
 * from `selvaged` — so the second joiner cannot ask for the document until that window closes. A
 * read that gave up at a fixed five seconds refused a hold the room would have answered.
 *
 * Two joiners are needed to see it, and the suite had one: the *first* joiner is answered at once,
 * because the state that answers its announcement is the one that opened the window.
 */
test('a guest that joins after the host seeded a path is answered from the room', { timeout: STEP_MS * 4 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-joiner-host');
  const body = 'FizzBuzz, with one branch\nsecond line here\n';
  await put(hostFolder, 'one.txt', body);

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const first = await Tool.start(t, 'first', {
    cwd: await scratch('e2e-joiner-first'),
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });
  const second = await Tool.start(t, 'second', {
    cwd: await scratch('e2e-joiner-second'),
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'heidi' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const invite = inviteOf(hosted);
  const joined = await first.call('session_join', { invite });
  assert.match(joined, /^joined room /, `the first guest did not join: ${joined}`);
  await until(
    'the host to see two seats',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // The host's own read is the seed, and the guest that was there for it is answered by the room.
  assert.equal(await host.call('read_file', { path: 'one.txt' }), body, 'the host read something else');
  assert.equal(await first.call('read_file', { path: 'one.txt' }), body, 'the first guest read something else');

  // The second joiner arrives inside the window the host's answer to the first one opened.
  const secondJoined = await second.call('session_join', { invite });
  assert.match(secondJoined, /^joined room /, `the second guest did not join: ${secondJoined}`);
  await until(
    'the host to see three seats',
    () => host.raw('session_status'),
    (text) => /^participants: 3$/m.test(text),
    STEP_MS,
  );

  const answer = await second.call('read_file', { path: 'one.txt' }, STEP_MS * 2);
  assert.equal(answer, body, 'the second joiner was not answered from the room');

  // One copy in the room and one in the folder: the wait neither doubled the text nor wrote one.
  const inRoom = await host.call('read_file', { path: 'one.txt' });
  assert.equal(inRoom.split(body).length - 1, 1, `the room holds the text ${inRoom.split(body).length - 1} times`);
  assert.equal(await readFile(join(hostFolder, 'one.txt'), 'utf8'), body, "the host's folder holds something else");
});

/**
 * What the option is for: a person in the room can see where the agent is working. The host asks
 * for a cursor through the variable — the configuration a client writes down — and reads a shared
 * file; the guest, which never asked for one, sees the host's seat publish a cursor and its own
 * seat still without one.
 */
test('a guest sees the host\'s cursor once the host asks for one', { timeout: STEP_MS * 2 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-cursor-host');
  await put(hostFolder, 'a.txt', 'ada types here\n');

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: {
      ...process.env,
      SELVAGE_SERVER_URL: selvaged.wsBase,
      SELVAGE_DISPLAY_NAME: 'ada',
      SELVAGE_PUBLISH_CURSOR: '1',
    },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: await scratch('e2e-cursor-guest'),
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const joined = await guest.call('session_join', { invite: inviteOf(hosted) });
  assert.ok(joined.includes(roomIdOf(hosted)), `the guest joined another room: ${joined}`);
  await until(
    'the host to see the guest',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // The read is what puts the cursor on the path; before it the host publishes only its identity.
  await host.call('read_file', { path: 'a.txt' });

  const seats = await until(
    "the guest to see the host's cursor",
    () => guest.raw('list_participants'),
    (text) => text.includes('ada (host, publishes a cursor)'),
    STEP_MS,
  );
  assert.match(seats, /grace \(guest, this connection, no cursor seen\)/);
});

/**
 * The proof is required, so the two ways of not having a server are failures with something to
 * act on rather than skips: a binary that is not there names the command that builds one, and a
 * binary that will not listen names what it did say instead of leaving a wait to run out.
 */
test('an absent or broken selvaged fails the proof, naming what to do', { timeout: 30_000 }, async () => {
  const named = process.env['SELVAGE_SELVAGED'];
  const restore = (): void => {
    if (named === undefined) {
      delete process.env['SELVAGE_SELVAGED'];
    } else {
      process.env['SELVAGE_SELVAGED'] = named;
    }
  };
  try {
    delete process.env['SELVAGE_SELVAGED'];
    assert.throws(
      () => selvagedBinary('/'),
      /cargo build -p selvaged/,
      'a missing binary did not name the command that builds it',
    );

    // A binary that is there and will not listen: this host's own interpreter is one.
    process.env['SELVAGE_SELVAGED'] = process.execPath;
    await assert.rejects(
      () => RealSelvaged.start(),
      /exited before it printed an address/,
      'a binary that never listened did not report what it said',
    );
  } finally {
    restore();
  }
});
