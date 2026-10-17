/**
 * The protocol as a client sees it: the entry point as a child process, one line of JSON per
 * message, and the answers it gives to a real sequence of them.
 *
 * What is asserted here is only what a process can show — the framing, the lifecycle, which
 * messages get answered and which do not, and that stdout carries nothing else. The refusal codes
 * that a process would prove nothing extra about are in `registry.test.ts`, against the objects
 * themselves.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';

import { ENTRY, StdioServer, assertMessagesOnly } from './helpers/stdio-client.ts';
import { put, remove, scratch } from './helpers/scratch.ts';

/** The preload that gives a child process a live session: see `helpers/live-engine.ts`. */
const LIVE_ENGINE = new URL('./helpers/live-engine.ts', import.meta.url).href;

/** The version the server should announce, from the package rather than from this file. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function start(t: TestContext): StdioServer {
  const server = StdioServer.start();
  t.after(() => server.stop());
  return server;
}

function initialize(id: number, protocolVersion: string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } },
  };
}

const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

function ping(id: number): unknown {
  return { jsonrpc: '2.0', id, method: 'ping' };
}

test('initialize answers with the negotiated version, the tool capability and its own name', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-06-18'));
  const result = (await server.nextResult(1, 'the initialize result')) as Record<string, unknown>;
  assert.equal(result['protocolVersion'], '2025-06-18', 'the version the client asked for');
  assert.deepEqual(result['capabilities'], { tools: {} }, 'the documented minimum for tools');
  assert.deepEqual(result['serverInfo'], { name: 'selvage-mcp', version: PACKAGE_VERSION });
  // One request, one line, and nothing else on the stream.
  assert.equal(assertMessagesOnly(server.rawStdout()).length, 1);
  assert.equal((await server.close()).code, 0);
});

test('a revision this server does not speak is answered with the latest one it does', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2026-07-28'));
  const result = (await server.nextResult(1, 'the initialize result')) as Record<string, unknown>;
  assert.equal(
    result['protocolVersion'],
    '2025-11-25',
    'a version in the client SDKs own supported list, so the client does not have to disconnect',
  );
  await server.close();
});

test('a request before initialize is refused, and ping is not', async (t) => {
  const server = start(t);
  server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const error = await server.nextError(1, 'the refusal of a tools/list before initialize');
  assert.equal(error['code'], -32000);
  assert.match(String(error['message']), /not initialized/i);

  // `2025-11-25/basic/utilities/ping.mdx` requires an answer at any point, so the lifecycle
  // gate is not allowed to reach it.
  server.send(ping(2));
  assert.deepEqual(await server.nextResult(2, 'the ping result'), {});
  await server.close();
});

test('notifications/initialized is recorded, never answered, and does not admit a request by itself', async (t) => {
  const first = start(t);
  first.send(INITIALIZED);
  first.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const refused = await first.nextError(1, 'the refusal of a tools/list after only the notification');
  assert.equal(refused['code'], -32000, 'the notification alone is not a handshake');

  const second = start(t);
  second.send(initialize(1, '2025-11-25'));
  await second.nextResult(1, 'the initialize result');
  second.send(INITIALIZED);
  // A notification carries no id, so it can have no response: the ping after it is the fence that
  // shows nothing was written for it.
  second.send(ping(2));
  assert.deepEqual(await second.nextResult(2, 'the ping after notifications/initialized'), {});
  assert.equal(assertMessagesOnly(second.rawStdout()).length, 2, 'no line for the notification');
  await second.close();
});

test('a second initialize is refused', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the first initialize result');
  server.send(initialize(2, '2025-11-25'));
  const error = await server.nextError(2, 'the refusal of a second initialize');
  assert.equal(error['code'], -32600);
  assert.match(String(error['message']), /already initialized/i);
  await server.close();
});

test('an unknown method is refused, and an unknown notification is not answered', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');

  // `server/discover` is the probe a client speaking the 2026-07-28 revision sends, and an
  // unknown method is exactly the answer it reads this server as legacy on.
  server.send({ jsonrpc: '2.0', id: 2, method: 'server/discover' });
  const error = await server.nextError(2, 'the refusal of server/discover');
  assert.equal(error['code'], -32601);

  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  server.send({ jsonrpc: '2.0', method: 'resources/list' });
  server.send(ping(3));
  assert.deepEqual(await server.nextResult(3, 'the ping after two unknown notifications'), {});
  assert.equal(assertMessagesOnly(server.rawStdout()).length, 3);
  await server.close();
});

test('a line that is not JSON is refused without an id, and the connection stays usable', async (t) => {
  const server = start(t);
  server.sendRaw('this is not json');
  const line = await server.nextLine('the parse error');
  const message = JSON.parse(line) as Record<string, unknown>;
  assert.equal(message['jsonrpc'], '2.0');
  assert.ok(!('id' in message), `the id was not readable, so it is omitted: ${line}`);
  const error = message['error'] as Record<string, unknown>;
  assert.equal(error['code'], -32700);

  server.send(ping(1));
  assert.deepEqual(await server.nextResult(1, 'the ping after a malformed line'), {});
  await server.close();
});

test('a null id and a batch are refused, and neither echoes a null id', async (t) => {
  const server = start(t);
  server.sendRaw('{"jsonrpc":"2.0","id":null,"method":"ping"}');
  const line = await server.nextLine('the refusal of a null id');
  const message = JSON.parse(line) as Record<string, unknown>;
  assert.ok(!('id' in message), `null is not an id this protocol has: ${line}`);
  assert.equal((message['error'] as Record<string, unknown>)['code'], -32600);

  server.send({ jsonrpc: '2.0', method: 'ping' });
  server.sendRaw('[{"jsonrpc":"2.0","id":2,"method":"ping"}]');
  const batch = JSON.parse(await server.nextLine('the refusal of a batch')) as Record<string, unknown>;
  assert.equal((batch['error'] as Record<string, unknown>)['code'], -32600);

  server.send(ping(3));
  assert.deepEqual(await server.nextResult(3, 'the ping after two malformed lines'), {});
  await server.close();
});

test('an argument set that does not fit the method is invalid params, not a crash', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');

  const cases: readonly { readonly what: string; readonly message: unknown }[] = [
    {
      what: 'a tools/call with no tool name',
      message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} },
    },
    {
      what: 'a tools/call naming a tool this server does not have',
      message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'host_session' } },
    },
    {
      what: 'a tools/call whose arguments are an array',
      message: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'host_session', arguments: [] },
      },
    },
    {
      what: 'a tools/call whose params are a string',
      message: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: 'host_session' },
    },
    {
      what: 'a tools/list carrying a cursor this server never issued',
      message: { jsonrpc: '2.0', id: 6, method: 'tools/list', params: { cursor: 'page-2' } },
    },
  ];
  for (const { what, message } of cases) {
    server.send(message);
    const error = await server.nextError((message as { id: number }).id, `the refusal of ${what}`);
    assert.equal(error['code'], -32602, `${what}: ${JSON.stringify(error)}`);
  }

  // Every one of those was a refusal of the message and not of the connection.
  server.send(ping(7));
  assert.deepEqual(await server.nextResult(7, 'the ping after five refusals'), {});
  await server.close();
});

test('tools/list answers one page of tools, with no cursor to keep', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');
  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const result = (await server.nextResult(2, 'the tools/list result')) as Record<string, unknown>;
  assert.ok(!('nextCursor' in result), 'a missing cursor is the end of the results');

  // The real registry, over the real session: the nine tools an agent reads, in the order they
  // were registered, each with a schema a caller can fill in and a description to choose by.
  const listed = result['tools'];
  assert.ok(Array.isArray(listed), `tools is a list: ${JSON.stringify(listed)}`);
  const tools = listed as readonly {
    readonly name: unknown;
    readonly description: unknown;
    readonly inputSchema: Record<string, unknown>;
  }[];
  assert.deepEqual(
    tools.map((one) => one.name),
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
    ],
  );
  for (const one of tools) {
    const name = String(one.name);
    assert.equal(typeof one.description, 'string', name);
    assert.ok((one.description as string).length > 80, `${name} needs a description to choose by`);
    assert.equal(one.inputSchema['type'], 'object', name);
    assert.equal(one.inputSchema['additionalProperties'], false, name);
    const properties = one.inputSchema['properties'];
    assert.ok(typeof properties === 'object' && properties !== null, `${name} names no properties`);
    for (const required of (one.inputSchema['required'] ?? []) as readonly string[]) {
      assert.ok(required in properties, `${name} requires "${required}" without naming it`);
    }
  }
  await server.close();
});

test('stdout carries nothing but protocol messages, and a diagnostic goes to stderr', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');
  server.sendRaw('} not json {');
  const line = await server.nextLine('the parse error');
  const refused = JSON.parse(line) as Record<string, unknown>;
  assert.equal(refused['jsonrpc'], '2.0');
  assert.equal((refused['error'] as Record<string, unknown>)['code'], -32700);

  await server.waitForDiagnostic('refusing a malformed message', 'the stderr diagnostic');
  const messages = assertMessagesOnly(server.rawStdout());
  assert.equal(messages.length, 2, server.report());
  assert.ok(
    server.stderr().startsWith('selvage-mcp:'),
    `a diagnostic is named for the process that wrote it: ${JSON.stringify(server.stderr())}`,
  );
  await server.close();
});

test('end of input shuts the server down with nothing left unflushed', async (t) => {
  const server = start(t);
  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');
  const exit = await server.close();
  assert.deepEqual(exit, { code: 0, signal: null }, server.report());
  assert.equal(assertMessagesOnly(server.rawStdout()).length, 1);
  await server.waitForDiagnostic('stdin closed', 'the shutdown diagnostic');
});

test('end of input on a live session leaves it, and the process follows its client out', async (t) => {
  // The engine's socket is not `unref`ed, so a process that holds a session and never leaves it
  // outlives the client that closed stdin. `helpers/live-engine.ts` gives this child a room whose
  // connection is a timer only leaving can clear, which is that socket's shape: exit here means
  // the session was left, and no exit means the process outlived its client.
  const server = StdioServer.startCommand(process.execPath, ['--import', LIVE_ENGINE, ENTRY]);
  t.after(() => server.stop());
  const folder = await scratch('stdio-live');
  t.after(() => remove(folder));
  await put(folder, 'a.txt', 'one\n');

  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');
  server.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'session_host',
      arguments: { folder, server_url: 'ws://room.example' },
    },
  });
  const hosted = (await server.nextResult(2, 'the session_host result')) as {
    readonly isError?: unknown;
    readonly content?: readonly { readonly text?: unknown }[];
  };
  assert.equal(hosted.isError, undefined, JSON.stringify(hosted));
  assert.match(String(hosted.content?.[0]?.text), /room-1/, 'the session under test is live');

  const exit = await server.close();
  assert.deepEqual(exit, { code: 0, signal: null }, server.report());
  await server.waitForDiagnostic('leaving the session', 'the shutdown of the live session');
  assert.equal(assertMessagesOnly(server.rawStdout()).length, 2);
});

test('a room that never answers is bounded, and the process still follows its client out', async (t) => {
  const server = StdioServer.startCommand(
    process.execPath,
    ['--import', LIVE_ENGINE, ENTRY],
    { env: { ...process.env, SELVAGE_TEST_ENGINE_STUCK: '1' } },
  );
  t.after(() => server.stop());
  const folder = await scratch('stdio-stuck');
  t.after(() => remove(folder));
  await put(folder, 'a.txt', 'one\n');

  server.send(initialize(1, '2025-11-25'));
  await server.nextResult(1, 'the initialize result');
  server.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'session_host',
      arguments: { folder, server_url: 'ws://room.example' },
    },
  });
  assert.equal(
    ((await server.nextResult(2, 'the session_host result')) as { readonly isError?: unknown }).isError,
    undefined,
  );

  // The leave never comes back, so the deadline is what ends the process — with a failed exit and
  // the sentence saying why, rather than outliving the client that closed the pipe.
  const exit = await server.close();
  assert.deepEqual(exit, { code: 1, signal: null }, server.report());
  await server.waitForDiagnostic('the room did not answer within 2000 ms', 'the bound diagnostic');
});
