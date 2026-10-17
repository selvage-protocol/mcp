/**
 * One MCP server process, driven the way a client drives it: started over its real stdio,
 * handshaken, and called one `tools/call` at a time. Shared by the end-to-end proofs so both
 * speak the shipped process rather than a second implementation in the test.
 */

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import { StdioServer } from './stdio-client.ts';
import type { SpawnOptions } from './stdio-client.ts';

/** The deadline one call gets unless the caller names its own. */
export const STEP_MS = 20_000;

export class Tool {
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

  /**
   * One `tools/call` sent without waiting for its answer, so a call can be held in the background
   * while other calls on the same server are made. Answers with the id to read it back by.
   */
  send(name: string, args: Record<string, unknown> = {}): number {
    const id = this.nextId++;
    this.server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    return id;
  }

  /**
   * The answer to a call `send` started, read when it is the next thing this server writes. Every
   * call made in between has to have been read already, because the line read is the next one.
   */
  async answered(id: number, name: string, ms: number = STEP_MS): Promise<string> {
    const result = (await this.server.nextResult(id, `${name} on ${this.label}`, ms)) as {
      readonly content?: readonly { readonly text?: string }[];
      readonly isError?: boolean;
    };
    const text = (result.content ?? []).map((block) => block.text ?? '').join('');
    return result.isError === true ? `refused: ${text}` : text;
  }

  /** One `tools/call`, returning what it answered in band — a refusal included. */
  async raw(name: string, args: Record<string, unknown> = {}, ms: number = STEP_MS): Promise<string> {
    return await this.answered(this.send(name, args), name, ms);
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
