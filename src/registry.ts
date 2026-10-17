/**
 * The tools this server offers, and the one place a `tools/call` is validated and dispatched.
 *
 * There are no tools yet: `tools/list` answers with the empty list until stage 2 registers the
 * session tools, and the registry is what it will register them into. It exists now because the
 * two halves it decides have to be right before anything is built on them — an argument set is
 * checked against the tool's own `inputSchema` before the tool sees it, and an execution error is
 * a *result* carrying `isError: true` rather than a protocol error, which is the distinction
 * `2025-11-25/server/tools.mdx` draws so that the caller can see the failure and correct itself.
 *
 * A tool that is not there, or whose arguments do not fit it, is a different thing entirely: a
 * protocol error the server answers with `-32602`. That is why `call` reports what happened in
 * these terms rather than throwing — the mapping to JSON-RPC codes belongs to the protocol layer.
 */

import { SchemaError, checkInputSchema, validate } from './schema.ts';
import type { JsonSchema } from './schema.ts';

/**
 * A block of a result. The specification has five kinds; `text` is the only one this server can
 * produce until there is a tool that reads a file, and the union grows with them.
 */
export interface TextContent {
  readonly type: 'text';
  readonly text: string;
}

export type ContentBlock = TextContent;

/** What a tool answers with. `isError` absent means the call did what it was asked. */
export interface CallToolResult {
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
}

/** Runs a tool over an argument set already checked against its own `inputSchema`. */
export type ToolHandler = (
  args: Readonly<Record<string, unknown>>,
) => CallToolResult | Promise<CallToolResult>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly handler: ToolHandler;
}

/** A `tools/list` entry: what a caller is told about a tool, without the handler behind it. */
export interface ToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

/** What one call did. Every branch but `called` is answered by the server, not by a tool. */
export type ToolCallOutcome =
  | { readonly kind: 'called'; readonly result: CallToolResult }
  | { readonly kind: 'unknownTool' }
  | { readonly kind: 'invalidArguments'; readonly problems: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  /**
   * A description is required and has to say something: an agent chooses a tool by reading it,
   * and a tool that arrives without one is a name it has to guess about. Uniqueness is the other
   * rule — the protocol addresses a tool by name alone, so two of them is one wrong answer.
   */
  register(tool: ToolDefinition): void {
    if (typeof tool.name !== 'string' || tool.name === '') {
      throw new SchemaError('a tool needs a name');
    }
    if (this.tools.has(tool.name)) {
      throw new SchemaError(`a tool named "${tool.name}" is already registered`);
    }
    if (typeof tool.description !== 'string' || tool.description.trim() === '') {
      throw new SchemaError(`"${tool.name}" needs a description`);
    }
    checkInputSchema(tool.inputSchema);
    this.tools.set(tool.name, tool);
  }

  /** Every tool, in the order it was registered: one page, with no cursor to hand back. */
  list(): readonly ToolDescription[] {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Validates `args` against the tool's own schema and runs it. A handler that throws is
   * reported as `failed` rather than as a result: an unexpected throw is a fault in this server,
   * and it is answered as one, where a tool that *decided* something was wrong says so with
   * `isError: true`.
   */
  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { kind: 'unknownTool' };
    }
    const problems = validate(args, tool.inputSchema);
    if (problems.length > 0) {
      return { kind: 'invalidArguments', problems };
    }
    try {
      return { kind: 'called', result: await tool.handler(args) };
    } catch (error: unknown) {
      return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
