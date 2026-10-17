/**
 * The tool surface as a client reaches it over the wire: the registry `src/main.ts` registers,
 * answering on the real stdio process, and the line the protocol draws between a call that went
 * wrong and a call that was never one — an execution failure is a result carrying `isError: true`,
 * while a tool this server does not have, or an argument set that does not fit the tool it names,
 * is a protocol error the caller has to fix before it can be a call at all.
 *
 * What the tools decide is held in `tools.test.ts`, against a stub engine. What is asserted here
 * is what only a process can show: that the shipped entry point is the one answering, that a tool
 * with nothing live to work on refuses in band, and that a message this server will not dispatch
 * is refused out of band, with the connection still usable either way.
 */

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { StdioServer } from './helpers/stdio-client.ts';

function start(t: TestContext): StdioServer {
  const server = StdioServer.start();
  t.after(() => server.stop());
  return server;
}

/** A server past the handshake, which is the only phase a tool can be called in. */
async function ready(t: TestContext): Promise<StdioServer> {
  const server = start(t);
  server.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  });
  await server.nextResult(1, 'the initialize result');
  return server;
}

/** One `tools/call`, as a client writes it. */
function call(id: number, name: string, args?: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: args === undefined ? { name } : { name, arguments: args },
  };
}

/** The one text block these tools answer with. */
function textOf(result: unknown): string {
  const shape = result as { readonly isError?: unknown; readonly content?: unknown };
  assert.ok(Array.isArray(shape.content), `a result carries content: ${JSON.stringify(result)}`);
  const block = (shape.content as readonly { readonly type?: unknown; readonly text?: unknown }[])[0];
  assert.equal(block?.type, 'text');
  return String(block?.text);
}

test('a tool that needs a session refuses in band when there is none, and not as a protocol error', async (t) => {
  const server = await ready(t);
  const calls: readonly (readonly [number, string, unknown?])[] = [
    [2, 'session_leave'],
    [3, 'list_paths'],
    [4, 'read_file', { path: 'a.txt' }],
    [5, 'edit_file', { path: 'a.txt', old_string: 'a', new_string: 'b' }],
    [6, 'list_participants'],
  ];
  for (const [id, name, args] of calls) {
    server.send(call(id, name, args));
    // `nextResult` fails on a response carrying an `error`, which is the distinction under test.
    const result = await server.nextResult(id, `the ${name} result`);
    assert.equal((result as { isError?: unknown }).isError, true, `${name}: ${JSON.stringify(result)}`);
    const text = textOf(result);
    assert.match(text, /no live session/, `${name}: ${text}`);
    assert.ok(!text.includes('no-session'), `${name} leaked an internal code: ${text}`);
  }
  await server.close();
});

test('a tool this server does not have is a protocol error, and the connection survives it', async (t) => {
  const server = await ready(t);
  server.send(call(2, 'session_hosts'));
  const error = await server.nextError(2, 'the refusal of an unknown tool');
  assert.equal(error['code'], -32602, JSON.stringify(error));
  assert.match(String(error['message']), /no tool named "session_hosts"/);

  server.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(await server.nextResult(3, 'the ping after an unknown tool'), {});
  await server.close();
});

test('session_status answers before any session rather than failing, which is the one tool that can', async (t) => {
  const server = await ready(t);
  server.send(call(2, 'session_status'));
  const result = await server.nextResult(2, 'the session_status result');
  assert.equal((result as { isError?: unknown }).isError, undefined, JSON.stringify(result));
  assert.match(textOf(result), /no session/);

  // And the session it reports on is this process's own: a tool that needs one still refuses.
  server.send(call(3, 'list_paths'));
  assert.equal((await server.nextResult(3, 'the list_paths result') as { isError?: unknown }).isError, true);
  await server.close();
});

test('an argument set that does not fit the tool it names is invalid params, before any handler runs', async (t) => {
  const server = await ready(t);
  const misfits: readonly (readonly [string, Record<string, unknown>])[] = [
    ['a required argument is missing', { name: 'read_file', arguments: {} }],
    ['an argument is of the wrong type', { name: 'read_file', arguments: { path: 7 } }],
    ['an argument the tool does not declare', { name: 'session_status', arguments: { folder: '/nowhere' } }],
    ['a limit outside the tool\'s own type', { name: 'list_paths', arguments: { limit: 'many' } }],
  ];
  let id = 2;
  for (const [what, params] of misfits) {
    server.send({ jsonrpc: '2.0', id, method: 'tools/call', params });
    const error = await server.nextError(id, `the refusal of ${what}`);
    assert.equal(error['code'], -32602, `${what}: ${JSON.stringify(error)}`);
    id += 1;
  }

  server.send(call(id, 'session_status'));
  const result = await server.nextResult(id, 'the session_status after four refusals');
  assert.match(textOf(result), /no session/, 'the session was never entered');
  await server.close();
});
