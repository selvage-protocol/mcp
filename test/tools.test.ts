/**
 * The ten tools against a stub engine: the schemas they register with, what each answers, and
 * what each refuses. The engine is a stub for the same reason the adapter's own tests use one —
 * a tool's decisions are not the room's, and the room's behaviour is held elsewhere.
 *
 * The stdio process surface gets its own file (`tools-stdio.test.ts`); what is here is the part a
 * process would prove nothing extra about.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { ToolRegistry } from '../src/registry.ts';
import type { CallToolResult, ToolDefinition } from '../src/registry.ts';
import { Session } from '../src/session.ts';
import type { SessionOptions } from '../src/session.ts';
import { createSessionTools, MAX_WAIT_MS } from '../src/tools.ts';
import { StubEngine, StubFactory, peer } from './helpers/stub-engine.ts';
import { TMP, put, remove, scratch } from './helpers/scratch.ts';

/** A link of the shape §5.1 writes: the page's or the wire's, with both keys in the fragment. */
const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

interface Bench {
  readonly tools: readonly ToolDefinition[];
  readonly session: Session;
  readonly engine: StubEngine;
  readonly factory: StubFactory;
}

function bench(
  options: {
    readonly engine?: StubEngine;
    readonly env?: Record<string, string | undefined>;
    readonly session?: Omit<SessionOptions, 'engines'>;
  } = {},
): Bench {
  const engine = options.engine ?? new StubEngine({ role: 'host', invite: INVITE });
  const factory = new StubFactory(engine);
  const session = new Session({ ...(options.session ?? {}), engines: factory });
  return { tools: createSessionTools(session, options.env ?? {}), session, engine, factory };
}

function tool(benchmark: Bench, name: string): ToolDefinition {
  const found = benchmark.tools.find((one) => one.name === name);
  assert.ok(found !== undefined, `no tool named ${name}`);
  return found;
}

async function call(
  benchmark: Bench,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return await tool(benchmark, name).handler(args);
}

function textOf(result: CallToolResult): string {
  assert.equal(result.content.length, 1, 'one text block is what these tools answer with');
  const block = result.content[0];
  assert.equal(block?.type, 'text');
  return block?.text ?? '';
}

/** The text of a result that is required to be the caller's own mistake. */
function failed(result: CallToolResult): string {
  const text = textOf(result);
  assert.equal(result.isError, true, `expected an error result, got: ${text}`);
  return text;
}

test('the surface is ten tools whose schemas register, each with a name and a description', () => {
  const benchmark = bench();
  assert.deepEqual(
    benchmark.tools.map((one) => one.name),
    [
      'session_host',
      'session_join',
      'session_status',
      'session_leave',
      'list_paths',
      'read_file',
      'edit_file',
      'write_file',
      'list_participants',
      'wait_for_change',
    ],
  );
  const registry = new ToolRegistry();
  for (const one of benchmark.tools) {
    registry.register(one);
  }
  assert.equal(registry.list().length, 10);
  for (const one of benchmark.tools) {
    assert.ok(
      one.description.length > 80,
      `${one.name} needs a description an agent can choose by`,
    );
    assert.equal(one.inputSchema.type, 'object', one.name);
    assert.equal(one.inputSchema.additionalProperties, false, one.name);
    for (const name of one.inputSchema.required ?? []) {
      assert.ok(
        one.inputSchema.properties !== undefined && name in one.inputSchema.properties,
        `${one.name} requires "${name}" without naming it`,
      );
    }
  }
});

test('hosting answers with the room, the complete invite and the granted path count', async () => {
  const root = await scratch('tools-host');
  try {
    await put(root, 'a.txt', 'one\n');
    await put(root, 'src/b.txt', 'two\n');
    const benchmark = bench();
    const result = await call(benchmark, 'session_host', {
      folder: root,
      server_url: 'ws://room.example',
      display_name: 'agent',
    });
    assert.equal(result.isError, undefined, textOf(result));
    const text = textOf(result);
    assert.match(text, /room-1/);
    assert.ok(text.includes(INVITE), `the invite is what this tool is for: ${text}`);
    assert.match(text, /2 granted path\(s\)/);
    assert.equal(benchmark.factory.hosted.length, 1);
    assert.equal(benchmark.factory.hosted[0]?.displayName, 'agent');
  } finally {
    await remove(root);
  }
});

test('the server address falls back to SELVAGE_SERVER_URL, and its absence names both places to set it', async () => {
  const root = await scratch('tools-url');
  try {
    await put(root, 'a.txt', 'one\n');
    const missing = bench();
    const refused = failed(await call(missing, 'session_host', { folder: root }));
    assert.match(refused, /server_url/);
    assert.match(refused, /SELVAGE_SERVER_URL/);
    assert.equal(missing.factory.hosted.length, 0, 'nothing is hosted without an address');

    const fromEnv = bench({ env: { SELVAGE_SERVER_URL: 'ws://env.example' } });
    const result = await call(fromEnv, 'session_host', { folder: root });
    assert.equal(result.isError, undefined, textOf(result));
    // The engine is handed the address under its own name for it.
    assert.equal(fromEnv.factory.hosted[0]?.baseUrl, 'ws://env.example');
  } finally {
    await remove(root);
  }
});

test('a host the engine will not open comes back as an error result, not as an internal error', async () => {
  const root = await scratch('tools-host-failed');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench();
    benchmark.factory.hostError = new Error('the connection was refused');
    const refused = failed(
      await call(benchmark, 'session_host', {
        folder: root,
        server_url: 'ws://room.example',
      }),
    );
    // Everything the caller did wrong comes back as a result they can see and correct, and a
    // server that is not up is the caller's address rather than a fault of this process.
    assert.match(refused, /did not come up/);
    assert.ok(!refused.includes('host-failed'), `a refusal code is internal: ${refused}`);
    assert.equal(benchmark.session.hasSession(), false);
  } finally {
    await remove(root);
  }
});

test('the display name is the argument, then the variable, then the fixed default', async () => {
  const root = await scratch('tools-name');
  try {
    await put(root, 'a.txt', 'one\n');
    const fromEnv = bench({ env: { SELVAGE_DISPLAY_NAME: 'from-env' } });
    await call(fromEnv, 'session_host', { folder: root, server_url: 'ws://room.example' });
    assert.equal(fromEnv.factory.hosted[0]?.displayName, 'from-env');

    const byArgument = bench({ env: { SELVAGE_DISPLAY_NAME: 'from-env' } });
    await call(byArgument, 'session_host', {
      folder: root,
      server_url: 'ws://room.example',
      display_name: 'explicit',
    });
    assert.equal(byArgument.factory.hosted[0]?.displayName, 'explicit');

    const byDefault = bench();
    await call(byDefault, 'session_host', { folder: root, server_url: 'ws://room.example' });
    assert.equal(byDefault.factory.hosted[0]?.displayName, 'agent');
  } finally {
    await remove(root);
  }
});

test('a folder that is not there, or is a file, is a caller error and no walk', async () => {
  const root = await scratch('tools-folder');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench();
    const absent = failed(
      await call(benchmark, 'session_host', {
        folder: join(TMP, 'tools-no-such-folder'),
        server_url: 'ws://room.example',
      }),
    );
    assert.match(absent, /no folder/);
    const file = failed(
      await call(benchmark, 'session_host', {
        folder: join(root, 'a.txt'),
        server_url: 'ws://room.example',
      }),
    );
    assert.match(file, /not a folder/);
    assert.equal(benchmark.factory.hosted.length, 0);
  } finally {
    await remove(root);
  }
});

test('a second session is a tool error naming the live room, with no internal code in the prose', async () => {
  const root = await scratch('tools-busy');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench();
    await call(benchmark, 'session_host', { folder: root, server_url: 'ws://room.example' });
    const refused = failed(
      await call(benchmark, 'session_host', { folder: root, server_url: 'ws://room.example' }),
    );
    assert.match(refused, /room-1/, 'the live session is named');
    assert.ok(!refused.includes('busy'), `a refusal code is internal: ${refused}`);
    assert.equal(benchmark.factory.hosted.length, 1);
  } finally {
    await remove(root);
  }
});

test('joining reports the room, the role, the participants and the granted path count', async () => {
  const target = new StubEngine({
    roomId: 'room-9',
    role: 'guest',
    listing: ['a.txt', 'b.txt'],
    peers: [peer('p1', 'dana', 'host')],
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  const result = await call(benchmark, 'session_join', { invite: INVITE, display_name: 'agent' });
  assert.equal(result.isError, undefined, textOf(result));
  const text = textOf(result);
  assert.match(text, /room-9/);
  assert.match(text, /as guest/);
  assert.match(text, /2 granted path\(s\)/);
  assert.match(text, /dana \(host/);
  assert.equal(benchmark.factory.joined[0]?.invite, INVITE);
  assert.equal(benchmark.factory.joined[0]?.displayName, 'agent');
});

test('a failed join reads back without the invite or its key in it', async () => {
  const benchmark = bench();
  benchmark.factory.joinError = new Error(`dial failed for ${INVITE}`);
  const refused = failed(await call(benchmark, 'session_join', { invite: INVITE }));
  assert.ok(!refused.includes(INVITE), `the invite is a credential: ${refused}`);
  assert.ok(!refused.includes('a'.repeat(43)), `the key must not survive a refusal: ${refused}`);
  assert.match(refused, /\[invite\]/);
});

test('session_status answers without a session, saying there is none', async () => {
  const benchmark = bench();
  const result = await call(benchmark, 'session_status');
  assert.equal(result.isError, undefined, 'asking where this server stands is not a mistake');
  assert.match(textOf(result), /no session/);
  assert.equal(benchmark.session.hasSession(), false);
});

test('session_status reports the live room, role, connection and participants', async () => {
  const root = await scratch('tools-status');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench({
      engine: new StubEngine({
        role: 'host',
        invite: INVITE,
        peers: [peer('p1', 'dana', 'guest')],
      }),
    });
    await call(benchmark, 'session_host', { folder: root, server_url: 'ws://room.example' });
    const text = textOf(await call(benchmark, 'session_status'));
    assert.match(text, /room: room-1/);
    assert.match(text, /role: host/);
    assert.match(text, /live: yes/);
    assert.match(text, /dana \(guest/);
    assert.match(text, /problems: none/);
  } finally {
    await remove(root);
  }
});

test('every tool that needs a session refuses without one, as a readable error result', async () => {
  const benchmark = bench();
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ['session_leave', {}],
    ['list_paths', {}],
    ['read_file', { path: 'a.txt' }],
    ['edit_file', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
    ['write_file', { path: 'a.txt', content: 'x' }],
    ['list_participants', {}],
  ];
  for (const [name, args] of cases) {
    const refused = failed(await call(benchmark, name, args));
    assert.match(refused, /there is no live session/, `${name}: ${refused}`);
    assert.ok(!refused.includes('no-session'), `${name} leaked a code: ${refused}`);
  }
});

test('list_paths answers sorted, and a bounded answer says it was truncated and names the limit', async () => {
  const benchmark = bench({
    engine: new StubEngine({ role: 'guest', listing: ['src/c.ts', 'a.txt', 'b.txt'] }),
    session: { grantWaitMs: 0 },
  });
  await call(benchmark, 'session_join', { invite: INVITE });
  assert.deepEqual(textOf(await call(benchmark, 'list_paths')).split('\n'), [
    'a.txt',
    'b.txt',
    'src/c.ts',
  ]);

  const cut = textOf(await call(benchmark, 'list_paths', { limit: 2 }));
  const lines = cut.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['a.txt', 'b.txt']);
  const notice = lines[2] ?? '';
  assert.match(notice, /truncated/);
  assert.match(notice, /2 of the 3/);
  assert.match(notice, /limit/);
});

test('list_paths filters by prefix before it bounds, and refuses a limit outside its cap', async () => {
  const benchmark = bench({
    engine: new StubEngine({
      role: 'guest',
      listing: ['src/a.ts', 'src/b.ts', 'test/c.ts'],
    }),
    session: { grantWaitMs: 0 },
  });
  await call(benchmark, 'session_join', { invite: INVITE });
  const text = textOf(await call(benchmark, 'list_paths', { prefix: 'src/' }));
  assert.deepEqual(text.split('\n'), ['src/a.ts', 'src/b.ts']);
  assert.match(
    textOf(await call(benchmark, 'list_paths', { prefix: 'nothing/' })),
    /no granted path starts with/,
  );

  const over = failed(await call(benchmark, 'list_paths', { limit: 1001 }));
  assert.match(over, /1000/);
  const zero = failed(await call(benchmark, 'list_paths', { limit: 0 }));
  assert.match(zero, /at least 1/);
});

test('read_file answers the text the room holds, and refuses a path the grant does not name', async () => {
  const benchmark = bench({
    engine: new StubEngine({
      role: 'guest',
      listing: ['a.txt'],
      texts: new Map([['a.txt', 'hello\n']]),
    }),
    session: { grantWaitMs: 0 },
  });
  await call(benchmark, 'session_join', { invite: INVITE });
  assert.equal(textOf(await call(benchmark, 'read_file', { path: 'a.txt' })), 'hello\n');
  const refused = failed(await call(benchmark, 'read_file', { path: 'b.txt' }));
  assert.match(refused, /granted no such path/);
  assert.ok(!refused.includes('not-granted'), refused);
});

test('edit_file replaces a unique old_string and publishes only that change', async () => {
  const target = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'hello world\n']]),
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE });
  const result = await call(benchmark, 'edit_file', {
    path: 'a.txt',
    old_string: 'world',
    new_string: 'room',
  });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(target.text('a.txt'), 'hello room\n');
  assert.match(textOf(result), /1 replacement/);
});

test('edit_file computes its replacement from the text under the hold, not from a read before it', async () => {
  // The room moves on between the two opens the call used to make: the read it took first, and
  // the hold its edit took second. A change computed against the first text and published into
  // the second replaces a range the document no longer has — `'1 TWO\n'`, not `'1 two\n'`.
  let opens = 0;
  const target = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'one two\n']]),
    onOpen: (path, stub) => {
      opens += 1;
      if (opens > 1) {
        stub.remote(path, 'ONE TWO\n');
      }
    },
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE });

  const result = await call(benchmark, 'edit_file', {
    path: 'a.txt',
    old_string: 'one',
    new_string: '1',
  });
  assert.equal(
    target.text('a.txt'),
    '1 two\n',
    `the edit was applied to a text the document no longer holds: ${textOf(result)}`,
  );
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /1 replacement/);

  // And the same window closed the other way: a hold finds a text the caller's `old_string` is
  // no longer in, which is the caller's own mistake rather than an edit to guess the range of.
  const moved = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'one two\n']]),
    onOpen: (path, stub) => {
      stub.remote(path, 'ONE TWO\n');
    },
  });
  const movedBench = bench({ engine: moved, session: { grantWaitMs: 0 } });
  await call(movedBench, 'session_join', { invite: INVITE });
  const refused = failed(
    await call(movedBench, 'edit_file', { path: 'a.txt', old_string: 'one', new_string: '1' }),
  );
  assert.match(refused, /does not appear/);
  assert.equal(moved.text('a.txt'), 'ONE TWO\n', 'a refusal changes nothing');
});

test('edit_file refuses an absent old_string, and an ambiguous one unless replace_all is set', async () => {
  const target = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'one one\n']]),
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE });

  const absent = failed(
    await call(benchmark, 'edit_file', { path: 'a.txt', old_string: 'two', new_string: 'x' }),
  );
  assert.match(absent, /does not appear/);

  const ambiguous = failed(
    await call(benchmark, 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'x' }),
  );
  assert.match(ambiguous, /appears 2 times/);
  assert.match(ambiguous, /replace_all/);
  assert.equal(target.text('a.txt'), 'one one\n', 'an ambiguous edit changes nothing');

  const empty = failed(
    await call(benchmark, 'edit_file', { path: 'a.txt', old_string: '', new_string: 'x' }),
  );
  assert.match(empty, /empty/);

  const all = await call(benchmark, 'edit_file', {
    path: 'a.txt',
    old_string: 'one',
    new_string: 'x',
    replace_all: true,
  });
  assert.equal(all.isError, undefined, textOf(all));
  assert.equal(target.text('a.txt'), 'x x\n');
  assert.match(textOf(all), /2 replacement/);
});

test('an old_string that only overlaps itself is ambiguous, and replace_all still replaces once', async () => {
  const target = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'aaa']]),
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE });

  // `'aa'` occurs in `'aaa'` at two positions, and only one of them survives a non-overlapping
  // scan: an edit that picked either would be guessing at which one the caller meant.
  const ambiguous = failed(
    await call(benchmark, 'edit_file', { path: 'a.txt', old_string: 'aa', new_string: 'b' }),
  );
  assert.match(ambiguous, /appears 2 times/);
  assert.equal(target.text('a.txt'), 'aaa', 'an overlapping old_string is never guessed at');

  const all = await call(benchmark, 'edit_file', {
    path: 'a.txt',
    old_string: 'aa',
    new_string: 'b',
    replace_all: true,
  });
  assert.equal(all.isError, undefined, textOf(all));
  // `split`/`join` replaces the non-overlapping occurrences, and that is what is reported.
  assert.equal(target.text('a.txt'), 'ba');
  assert.match(textOf(all), /1 replacement/);
});

test('write_file replaces the whole shared text, and a viewer is refused', async () => {
  const target = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    texts: new Map([['a.txt', 'old\n']]),
  });
  const benchmark = bench({ engine: target, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE });
  const result = await call(benchmark, 'write_file', { path: 'a.txt', content: 'new\n' });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(target.text('a.txt'), 'new\n');

  const viewing = bench({
    engine: new StubEngine({
      role: 'viewer',
      listing: ['a.txt'],
      texts: new Map([['a.txt', 'x']]),
    }),
    session: { grantWaitMs: 0 },
  });
  await call(viewing, 'session_join', { invite: INVITE });
  const refused = failed(
    await call(viewing, 'write_file', { path: 'a.txt', content: 'y' }),
  );
  assert.match(refused, /viewer/);
  assert.ok(!refused.includes('read-only'), refused);
});

test('list_participants names the seats, their roles and the presence each publishes', async () => {
  const root = await scratch('tools-seats');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench({
      engine: new StubEngine({
        role: 'host',
        invite: INVITE,
        self: peer('self', 'agent', 'host'),
        peers: [peer('p1', 'dana', 'guest', 7)],
        presence: [
          { clientId: 7, peer: peer('p1', 'dana', 'guest', 7), state: { path: 'a.txt' } },
        ],
      }),
    });
    await call(benchmark, 'session_host', { folder: root, server_url: 'ws://room.example' });
    const text = textOf(await call(benchmark, 'list_participants'));
    assert.match(text, /agent \(host, this connection, no cursor seen\)/);
    assert.match(text, /dana \(guest, publishes a cursor\)/);
  } finally {
    await remove(root);
  }
});

test('list_participants resolves a peer cursor to a line and column in the document it names', async () => {
  const root = await scratch('tools-seats-cursor');
  try {
    await put(root, 'a.txt', 'one\ntwo\nthree\n');
    const dana = peer('p1', 'dana', 'guest', 7);
    const benchmark = bench({
      engine: new StubEngine({
        role: 'host',
        invite: INVITE,
        self: peer('self', 'agent', 'host'),
        peers: [dana],
        texts: new Map([['a.txt', 'one\ntwo\nthree\n']]),
        presence: [
          {
            clientId: 7,
            peer: dana,
            state: {
              path: 'a.txt',
              selection: { anchor: { assoc: 0, tname: 'a.txt' }, head: { assoc: 0, tname: 'a.txt' } },
            },
          },
        ],
        resolveSelection: () => ({ anchor: 4, head: 7 }),
      }),
    });
    await call(benchmark, 'session_host', { folder: root, server_url: 'ws://room.example' });
    const text = textOf(await call(benchmark, 'list_participants'));
    assert.match(text, /dana \(guest, publishes a cursor\) in a\.txt selecting line 2, column 1 to line 2, column 4/);
  } finally {
    await remove(root);
  }
});

test('wait_for_change answers a deadline plainly, and a room change as a bounded hunk', async () => {
  const engine = new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\ntwo\n']]),
  });
  const benchmark = bench({ engine });
  await call(benchmark, 'session_join', { invite: INVITE });
  // This seat's own edit is the watermark, not a change to report back.
  await call(benchmark, 'edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' });

  const deadline = textOf(await call(benchmark, 'wait_for_change', { timeout_ms: 30 }));
  assert.match(deadline, /^no change within 30 ms: watched 1 path\(s\)/);

  engine.remote('a.txt', 'ONE\nTWO\n');
  engine.emit({ type: 'documentChanged', path: 'a.txt' });
  const changed = textOf(await call(benchmark, 'wait_for_change', { timeout_ms: 1_000 }));
  assert.match(changed, /^a\.txt: changed \(\d+ characters now\)$/m);
  assert.match(changed, /^- +2 two$/m);
  assert.match(changed, /^\+ +2 TWO$/m);
});

test('wait_for_change refuses a deadline above its cap and one that is not a count', async () => {
  const benchmark = bench({ engine: new StubEngine({ role: 'guest', listing: [] }) });
  await call(benchmark, 'session_join', { invite: INVITE });
  const over = failed(await call(benchmark, 'wait_for_change', { timeout_ms: MAX_WAIT_MS + 1 }));
  assert.match(over, /waits at most/);
  const zero = failed(await call(benchmark, 'wait_for_change', { timeout_ms: 0 }));
  assert.match(zero, /at least 1/);
});

test('session_leave frees the process, and a second leave is a caller error', async () => {
  const benchmark = bench({
    engine: new StubEngine({ role: 'guest', listing: [] }),
    session: { grantWaitMs: 0 },
  });
  await call(benchmark, 'session_join', { invite: INVITE });
  const left = await call(benchmark, 'session_leave');
  assert.equal(left.isError, undefined, textOf(left));
  assert.equal(benchmark.session.hasSession(), false);
  const again = failed(await call(benchmark, 'session_leave'));
  assert.match(again, /there is no live session/);
});

/** Every cursor publication an engine was asked for. */
function publishes(engine: StubEngine): string[] {
  return engine.calls.filter((call) => call.startsWith('setSelection'));
}

/** A guest whose room holds one path, so a read has something to point at. */
function guestRoom(): StubEngine {
  return new StubEngine({
    role: 'guest',
    listing: ['a.txt'],
    documents: ['a.txt'],
    texts: new Map([['a.txt', 'one\n']]),
  });
}

/** Joins, reads the one path, and answers with the bench so its engine can be inspected. */
async function joinedAndRead(
  args: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): Promise<Bench> {
  const benchmark = bench({ engine: guestRoom(), env, session: { grantWaitMs: 0 } });
  await call(benchmark, 'session_join', { invite: INVITE, ...args });
  await call(benchmark, 'read_file', { path: 'a.txt' });
  return benchmark;
}

test('the cursor is published only when the argument or the variable asks for it', async () => {
  assert.deepEqual(
    publishes((await joinedAndRead({})).engine),
    [],
    'a default join published a cursor',
  );

  assert.deepEqual(
    publishes((await joinedAndRead({ publish_cursor: true })).engine),
    ['setSelection a.txt 0..0'],
  );

  assert.deepEqual(
    publishes((await joinedAndRead({}, { SELVAGE_PUBLISH_CURSOR: 'on' })).engine),
    ['setSelection a.txt 0..0'],
  );

  // The variable is the fallback, so an argument beats it — an explicit `false` included.
  assert.deepEqual(
    publishes((await joinedAndRead({ publish_cursor: false }, { SELVAGE_PUBLISH_CURSOR: '1' })).engine),
    [],
  );

  // The variable's off spellings, and a value that is neither on nor off.
  for (const value of ['0', 'false', 'no', 'off', 'maybe', '']) {
    assert.deepEqual(
      publishes((await joinedAndRead({}, { SELVAGE_PUBLISH_CURSOR: value })).engine),
      [],
      `${JSON.stringify(value)} is not on`,
    );
  }
});

test('session_host carries the cursor choice to the session too', async () => {
  const root = await scratch('tools-cursor-host');
  try {
    await put(root, 'a.txt', 'one\n');
    const benchmark = bench();
    await call(benchmark, 'session_host', {
      folder: root,
      server_url: 'ws://room.example',
      publish_cursor: true,
    });
    // The stub's room is whatever the test says it is; the walk's listing is the session's own.
    benchmark.engine.listing = ['a.txt'];
    await call(benchmark, 'read_file', { path: 'a.txt' });
    assert.deepEqual(publishes(benchmark.engine), ['setSelection a.txt 0..0']);
  } finally {
    await remove(root);
  }
});
