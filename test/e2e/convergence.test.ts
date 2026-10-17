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
  async raw(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const id = this.nextId++;
    this.server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const result = (await this.server.nextResult(id, `${name} on ${this.label}`)) as {
      readonly content?: readonly { readonly text?: string }[];
      readonly isError?: boolean;
    };
    const text = (result.content ?? []).map((block) => block.text ?? '').join('');
    return result.isError === true ? `refused: ${text}` : text;
  }

  /** One `tools/call` that has to work. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const text = await this.raw(name, args);
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
