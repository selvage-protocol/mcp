/**
 * Interop against a real third-party client: the official `@modelcontextprotocol/sdk` from npm,
 * driving this server's process the way any other client would — `initialize`, `tools/list`, and
 * `tools/call` over the SDK's own stdio transport, with the SDK's own validation in the middle.
 *
 * The other tests speak the wire by hand, which is what makes them able to assert the shape of
 * every line. This one gives that up on purpose: it says nothing about the framing and asks
 * whether a client written by somebody else, from the specification, is satisfied by what this
 * server answers. An in-band failure and a protocol error are asserted separately, because the
 * two are the split the whole tool surface rests on.
 *
 * It needs no `selvaged`: what is under test is the protocol layer, and a client that can reach
 * this server at all reaches it over stdio.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { scratch } from './helpers/scratch.ts';
import { ENTRY } from './helpers/stdio-client.ts';
import { TOOL_NAMES } from './helpers/tool-names.ts';

/** What one result carries, read the way a caller reads it: the text blocks, and the flag. */
function read(result: unknown): { readonly text: string; readonly isError: boolean } {
  const shape = result as { readonly content?: unknown; readonly isError?: unknown };
  assert.ok(Array.isArray(shape.content), `a result carries content: ${JSON.stringify(result)}`);
  const text = (shape.content as readonly { readonly type?: string; readonly text?: string }[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  return { text, isError: shape.isError === true };
}

test('the official SDK initializes, lists the ten tools and calls them', { timeout: 30_000 }, async (t) => {
  const cwd = await scratch('interop');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd,
  });
  const client = new Client({ name: 'interop-probe', version: '1.0.0' });
  t.after(async () => {
    await client.close();
  });

  // `connect` is the handshake: the SDK sends `initialize`, refuses a protocol revision it does
  // not support, sends `notifications/initialized` and waits for no answer to it.
  await client.connect(transport);
  const server = client.getServerVersion();
  assert.equal(server?.name, 'selvage-mcp', `the server named itself ${JSON.stringify(server)}`);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    TOOL_NAMES,
    'the SDK did not read the ten tools off this server',
  );
  for (const tool of listed.tools) {
    assert.ok((tool.description ?? '').length > 0, `${tool.name} has no description for a client to choose by`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} declares no object schema`);
  }

  // A call that works without a session: asking where this server stands is not a mistake.
  const status = read(await client.callTool({ name: 'session_status' }));
  assert.equal(status.isError, false);
  assert.match(status.text, /^no session:/, `session_status answered ${status.text}`);

  // The same call that fails with nothing to work on is a result, not an exception.
  const leave = read(await client.callTool({ name: 'session_leave' }));
  assert.equal(leave.isError, true);
  assert.match(leave.text, /no live session/, `session_leave answered ${leave.text}`);

  // A tool this server does not have, and an argument set that does not fit one, are both
  // protocol errors: the SDK reports them as thrown `McpError`s, not as results.
  await assert.rejects(
    () => client.callTool({ name: 'no_such_tool' }),
    (error: unknown) => (error as { code?: unknown }).code === -32602,
    'an unknown tool was not refused out of band',
  );
  await assert.rejects(
    () => client.callTool({ name: 'read_file', arguments: {} }),
    (error: unknown) => (error as { code?: unknown }).code === -32602,
    'an argument set missing a required name was not refused out of band',
  );
});
