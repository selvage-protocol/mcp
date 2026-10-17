/**
 * The registry and the dispatch, driven as objects rather than as a process: what a tool has to
 * look like before it can be registered, what a call does with arguments that fit and with
 * arguments that do not, and which of those outcomes the server answers with a protocol error and
 * which it answers with a tool result.
 *
 * The distinction is the one worth a test of its own: a tool that *decides* something went wrong
 * says so in its result with `isError`, and only the calls that never reached a tool — an unknown
 * name, arguments the schema refuses — are protocol errors.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { JsonRpcResponse } from '../src/jsonrpc.ts';
import { ToolRegistry } from '../src/registry.ts';
import type { JsonSchema } from '../src/schema.ts';
import { SchemaError, validate } from '../src/schema.ts';
import { Server, negotiateVersion } from '../src/server.ts';

const NAME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    session: {
      type: 'object',
      required: ['port'],
      additionalProperties: false,
      properties: { port: { type: 'integer' } },
    },
  },
  required: ['session'],
  additionalProperties: false,
};

function registryWith(
  handler: (args: Readonly<Record<string, unknown>>) => unknown = () => ({
    content: [{ type: 'text', text: 'ok' }],
  }),
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'open_session',
    description: 'Opens a session against a running Selvage server.',
    inputSchema: NAME_SCHEMA,
    handler: handler as never,
  });
  return registry;
}

function errorOf(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok('error' in response, `expected an error, got ${JSON.stringify(response)}`);
  return response.error as unknown as Record<string, unknown>;
}

function resultOf(response: JsonRpcResponse): Record<string, unknown> {
  assert.ok('result' in response, `expected a result, got ${JSON.stringify(response)}`);
  return response.result as Record<string, unknown>;
}

test('a tool is refused unless its name, description and schema can all be used', () => {
  const cases: readonly { readonly what: string; readonly tool: unknown; readonly expected: RegExp }[] =
    [
      {
        what: 'a nameless tool',
        tool: { name: '', description: 'x', inputSchema: { type: 'object' }, handler: () => ({}) },
        expected: /needs a name/,
      },
      {
        what: 'a tool with a blank description',
        tool: { name: 'a', description: '  ', inputSchema: { type: 'object' }, handler: () => ({}) },
        expected: /needs a description/,
      },
      {
        what: 'a schema that is not an object at the root',
        tool: { name: 'a', description: 'x', inputSchema: { type: 'string' }, handler: () => ({}) },
        expected: /inputSchema root must be "type": "object"/,
      },
      {
        what: 'a schema using a keyword this server does not validate',
        tool: {
          name: 'a',
          description: 'x',
          inputSchema: { type: 'object', oneOf: [{ type: 'object' }] },
          handler: () => ({}) ,
        },
        expected: /uses "oneOf", which this server does not validate/,
      },
      {
        what: 'a schema with object keywords but no object type',
        tool: {
          name: 'a',
          description: 'x',
          inputSchema: { type: 'object', properties: { b: { type: 'string', required: ['c'] } } },
          handler: () => ({}),
        },
        expected: /b has object keywords but no "type": "object"/,
      },
      {
        what: 'a schema with items but no array type',
        tool: {
          name: 'a',
          description: 'x',
          inputSchema: { type: 'object', properties: { b: { items: { type: 'string' } } } },
          handler: () => ({}),
        },
        expected: /b has "items" but no "type": "array"/,
      },
    ];

  for (const { what, tool, expected } of cases) {
    assert.throws(
      () => {
        new ToolRegistry().register(tool as never);
      },
      (error: unknown) => error instanceof SchemaError && expected.test(error.message),
      what,
    );
  }

  // Registered twice, which the protocol cannot address: a tool is named, not indexed.
  const registry = registryWith();
  assert.throws(
    () => {
      registry.register({
        name: 'open_session',
        description: 'again',
        inputSchema: { type: 'object' },
        handler: () => ({ content: [] }),
      });
    },
    (error: unknown) => error instanceof SchemaError && /already registered/.test(error.message),
  );
});

test('list is one page in registration order, and carries no handler', () => {
  const registry = registryWith();
  registry.register({
    name: 'close_session',
    description: 'Closes it.',
    inputSchema: { type: 'object' },
    handler: () => ({ content: [] }),
  });
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['open_session', 'close_session'],
  );
  assert.deepEqual(Object.keys(registry.list()[0] as object).sort(), [
    'description',
    'inputSchema',
    'name',
  ]);
  assert.ok(registry.has('open_session'));
  assert.ok(!registry.has('Open_Session'), 'names are exact');
});

test('a call names a tool that is not there, or supplies arguments that do not fit', async () => {
  const registry = registryWith();
  assert.deepEqual(await registry.call('no_such_tool', {}), { kind: 'unknownTool' });

  const missing = await registry.call('open_session', {});
  assert.equal(missing.kind, 'invalidArguments');
  assert.deepEqual(missing.kind === 'invalidArguments' ? missing.problems : [], [
    'session: required property is missing',
  ]);

  const wrongTypes = await registry.call('open_session', { session: { port: '8080' } });
  assert.deepEqual(wrongTypes.kind === 'invalidArguments' ? wrongTypes.problems : [], [
    'session.port: expected integer, got a string',
  ]);

  const extra = await registry.call('open_session', { session: { port: 1 }, tls: true });
  assert.deepEqual(extra.kind === 'invalidArguments' ? extra.problems : [], [
    'tls: unknown property',
  ]);

  // Every problem at once, rather than the first one found: an agent correcting its call wants
  // the whole list.
  const both = await registry.call('open_session', { session: { port: 1, tls: true }, extra: 1 });
  assert.deepEqual(both.kind === 'invalidArguments' ? both.problems : [], [
    'session.tls: unknown property',
    'extra: unknown property',
  ]);
});

test('an argument named after Object.prototype is unknown, not declared', async () => {
  const registry = registryWith();
  // `Object.prototype` answers to these names, so a lookup that reads through the prototype
  // chain takes each of them for a declared property and lets it past
  // `additionalProperties: false`. The declaration and the required check are own-property ones.
  const cases: readonly (readonly [Record<string, unknown>, string])[] = [
    [{ session: { port: 1 }, constructor: 1 }, 'constructor: unknown property'],
    [{ session: { port: 1 }, toString: 1 }, 'toString: unknown property'],
    [{ session: { port: 1 }, hasOwnProperty: 1 }, 'hasOwnProperty: unknown property'],
    [{ session: { port: 1, valueOf: 1 } }, 'session.valueOf: unknown property'],
    // Exactly what an argument set spells on the wire: `JSON.parse` gives `__proto__` an own
    // entry, and reading it back off the prototype would find `Object.prototype` itself.
    [
      JSON.parse('{"session":{"port":1},"__proto__":1}') as Record<string, unknown>,
      '__proto__: unknown property',
    ],
  ];
  for (const [args, problem] of cases) {
    const outcome = await registry.call('open_session', args);
    assert.equal(outcome.kind, 'invalidArguments', `${JSON.stringify(args)} was taken as declared`);
    assert.deepEqual(outcome.kind === 'invalidArguments' ? outcome.problems : [], [problem]);
  }

  // The same hole in the other direction: a required name is satisfied by an own property and
  // by nothing the prototype chain happens to hold.
  assert.deepEqual(
    validate({}, { type: 'object', required: ['toString'], additionalProperties: false }),
    ['toString: required property is missing'],
  );
});

test('a call runs the handler over the arguments it checked', async () => {
  const seen: unknown[] = [];
  const registry = registryWith((args) => {
    seen.push(args);
    return { content: [{ type: 'text', text: JSON.stringify(args) }] };
  });
  const outcome = await registry.call('open_session', { session: { port: 7000 } });
  assert.equal(outcome.kind, 'called');
  assert.deepEqual(seen, [{ session: { port: 7000 } }]);
  assert.deepEqual(outcome.kind === 'called' ? outcome.result : undefined, {
    content: [{ type: 'text', text: '{"session":{"port":7000}}' }],
  });
});

test('a handler that throws is a fault, and a handler that decides is a result', async () => {
  const throwing = registryWith(() => {
    throw new Error('the socket went away');
  });
  assert.deepEqual(await throwing.call('open_session', { session: { port: 1 } }), {
    kind: 'failed',
    reason: 'the socket went away',
  });

  const deciding = registryWith(() => ({
    content: [{ type: 'text', text: 'no server is listening on that port' }],
    isError: true,
  }));
  const outcome = await deciding.call('open_session', { session: { port: 1 } });
  assert.equal(outcome.kind, 'called');
  assert.equal(outcome.kind === 'called' ? outcome.result.isError : undefined, true);
});

test('the server answers with the protocol error that fits, and keeps a tool failure in band', async () => {
  const registry = registryWith((args) => {
    // Valid arguments, an unexpected throw: the fault path and not the refusal path.
    if ((args['session'] as { port: number }).port === 13) {
      throw new Error('unexpected');
    }
    return { content: [{ type: 'text', text: 'opened' }] };
  });
  const logs: string[] = [];
  const server = new Server({
    serverInfo: { name: 'selvage-mcp', version: '0.1.0' },
    registry,
    log: (message) => logs.push(message),
  });
  await server.answer({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  server.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(server.phase, 'ready');

  const called = await server.answer({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'open_session', arguments: { session: { port: 7000 } } },
  });
  assert.deepEqual(resultOf(called), { content: [{ type: 'text', text: 'opened' }] });

  const unknown = await server.answer({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'host_session', arguments: {} },
  });
  assert.equal(errorOf(unknown)['code'], -32602);
  assert.match(String(errorOf(unknown)['message']), /no tool named "host_session"/);

  const invalid = await server.answer({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'open_session', arguments: { session: {} } },
  });
  assert.equal(errorOf(invalid)['code'], -32602);
  assert.deepEqual(errorOf(invalid)['data'], { problems: ['session.port: required property is missing'] });

  const fault = await server.answer({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'open_session', arguments: { session: { port: 13 } } },
  });
  assert.equal(errorOf(fault)['code'], -32603);
  // What the tool said goes to the log; the caller is told the call failed and nothing more,
  // because a stack's worth of detail about this server is not the caller's to read.
  assert.match(String(errorOf(fault)['message']), /Internal error: open_session failed/);
  assert.ok(
    logs.some((line) => line.includes('unexpected')),
    `the reason belongs in the log: ${logs.join('\n')}`,
  );

  const listed = await server.answer({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
  const tools = resultOf(listed)['tools'] as readonly Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.['name'], 'open_session');
  assert.deepEqual(tools[0]?.['inputSchema'], NAME_SCHEMA);
  assert.ok(!('handler' in (tools[0] as object)), 'a handler has no business on the wire');
  assert.ok(logs.some((line) => line.includes('unknown tool')), logs.join('\n'));
});

test('logging/setLevel is a method this server has only when it has a channel to log through', async () => {
  const levels: string[] = [];
  const logging = new Server({
    serverInfo: { name: 'selvage-mcp', version: '0.1.0' },
    logging: { setLevel: (level) => levels.push(level) },
  });
  const handshake = await logging.answer({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  assert.deepEqual(resultOf(handshake)['capabilities'], { tools: {}, logging: {} });
  logging.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const accepted = await logging.answer({
    jsonrpc: '2.0',
    id: 1,
    method: 'logging/setLevel',
    params: { level: 'warning' },
  });
  assert.deepEqual(resultOf(accepted), {});
  assert.deepEqual(levels, ['warning']);

  const refused = await logging.answer({
    jsonrpc: '2.0',
    id: 2,
    method: 'logging/setLevel',
    params: { level: 'loud' },
  });
  assert.equal(errorOf(refused)['code'], -32602);
  assert.match(String(errorOf(refused)['message']), /is not one of/);

  // A server with no channel declares no logging capability and does not have the method.
  const bare = new Server({ serverInfo: { name: 'selvage-mcp', version: '0.1.0' } });
  const bareHandshake = await bare.answer({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25' },
  });
  assert.deepEqual(resultOf(bareHandshake)['capabilities'], { tools: {} });
  bare.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const missing = await bare.answer({
    jsonrpc: '2.0',
    id: 1,
    method: 'logging/setLevel',
    params: { level: 'info' },
  });
  assert.equal(errorOf(missing)['code'], -32601);
});

test('negotiation gives back the revision asked for when it is one of ours, and the latest when it is not', () => {
  assert.equal(negotiateVersion('2025-11-25'), '2025-11-25');
  assert.equal(negotiateVersion('2025-06-18'), '2025-06-18');
  assert.equal(negotiateVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateVersion('2026-07-28'), '2025-11-25');
  assert.equal(negotiateVersion(''), '2025-11-25');
  assert.equal(negotiateVersion('latest'), '2025-11-25');
});
