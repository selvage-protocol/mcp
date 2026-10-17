/**
 * The MCP session as a client of `initialize` sees it: the handshake, the phase a request is
 * admitted in, and the four methods this server answers before there is a session to speak of.
 *
 * Everything here is `2025-11-25` — the legacy handshake, which is what every shipped client
 * speaks. `2026-07-28` removed it in favor of `_meta` on every request, and on stdio a client
 * that speaks the new revision finds out which era this is by probing `server/discover`: an
 * unknown method, so `-32601`, which is exactly the answer it treats as "legacy" and falls back
 * to `initialize` on. That answer is why nothing here special-cases `server/discover`.
 *
 * The phase is a real gate and the only one. A request that arrives before the handshake has
 * completed is refused with `-32000` — the implementation-defined range's lowest code, the one
 * the official TypeScript server uses for the same refusal with the same wording — rather than
 * answered against a server the client has not been told the shape of. `ping` is exempt, because
 * `2025-11-25/basic/utilities/ping.mdx` requires it to be answered at any point, and
 * `initialize` itself is what moves the phase.
 *
 * `notifications/initialized` is required of the *client* and is recorded, not enforced: after
 * it, and only after it, this server is willing to say the session is ready. Nothing is sent
 * before it either way — the specification's own restriction is on a server that has something
 * to send, and this one has not.
 */

import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  NOT_INITIALIZED,
  errorResponse,
  requestParams,
  result,
} from './jsonrpc.ts';
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './jsonrpc.ts';
import { ToolRegistry } from './registry.ts';
import type { ToolDescription } from './registry.ts';

/**
 * The revisions this server accepts, most recent first. The list is the shipped clients' own:
 * `2024-10-07` is left out because it never had a published specification, and a client that asks
 * for it is answered with `2025-11-25`, which it accepts — the string is in both SDK lines'
 * `SUPPORTED_PROTOCOL_VERSIONS`.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** What `initialize` answers with when the client asked for a revision this server does not have. */
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** How this server names itself. Read from the package, so the two cannot drift apart. */
export interface ServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface ServerOptions {
  readonly serverInfo: ServerInfo;
  readonly registry?: ToolRegistry;
  readonly instructions?: string;
  /** Where a message this server would not answer is reported. Never stdout. */
  readonly log?: (message: string) => void;
}

/**
 * How far the handshake has got. `fresh` is before any `initialize`; `initializing` is after this
 * server answered one and before `notifications/initialized`; `ready` is after that.
 */
export type Phase = 'fresh' | 'initializing' | 'ready';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The version to answer with: the client's own where it is one of ours, our latest otherwise. */
export function negotiateVersion(requested: string): string {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

export class Server {
  private readonly serverInfo: ServerInfo;
  private readonly registry: ToolRegistry;
  private readonly instructions: string | undefined;
  private readonly log: (message: string) => void;
  private currentPhase: Phase = 'fresh';

  constructor(options: ServerOptions) {
    this.serverInfo = options.serverInfo;
    this.registry = options.registry ?? new ToolRegistry();
    this.instructions = options.instructions;
    this.log = options.log ?? (() => undefined);
  }

  /** How far the handshake has got, for a caller that has to know and for the tests. */
  get phase(): Phase {
    return this.currentPhase;
  }

  /** Answers a request, or reports the fault that keeps it from being answerable. */
  async answer(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    switch (request.method) {
      case 'initialize':
        return this.initialize(request);
      case 'ping':
        // `2025-11-25/basic/utilities/ping.mdx`: an empty result, at any point in the session.
        return result(request.id, {});
      case 'tools/list':
        return this.gated(request, () => this.listTools(request));
      case 'tools/call':
        return this.gated(request, () => this.callTool(request));
      default:
        // Includes every method of a capability this server does not declare — `logging/setLevel`,
        // `resources/*`, `prompts/*`, `completions/complete` — which `2025-11-25` answers the same
        // way as a method that does not exist at all.
        this.log(`refusing unknown method ${request.method}`);
        return errorResponse(request.id, {
          code: METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        });
    }
  }

  /**
   * Takes a notification. None of them is answered — a notification carries no id, so there is
   * nothing to answer it with, and writing a response for one is the fastest way to desynchronize
   * a client's id bookkeeping.
   */
  notify(notification: JsonRpcNotification): void {
    if (notification.method === 'notifications/initialized') {
      if (this.currentPhase === 'initializing') {
        this.currentPhase = 'ready';
        return;
      }
      this.log(`ignoring notifications/initialized while ${this.currentPhase}`);
      return;
    }
    this.log(`ignoring notification ${notification.method}`);
  }

  /** Refuses anything but `ping` and `initialize` before the client's handshake has completed. */
  private async gated(
    request: JsonRpcRequest,
    work: () => JsonRpcResponse | Promise<JsonRpcResponse>,
  ): Promise<JsonRpcResponse> {
    if (this.currentPhase === 'fresh') {
      this.log(`refusing ${request.method} before initialize`);
      return errorResponse(request.id, {
        code: NOT_INITIALIZED,
        message: 'Bad Request: Server not initialized',
      });
    }
    return work();
  }

  /**
   * The handshake, once. The result's fields are the three the specification requires of it, and
   * the capabilities are the documented minimum: this server has tools, and it does not emit
   * `notifications/tools/list_changed`, so `listChanged` is absent rather than false.
   */
  private initialize(request: JsonRpcRequest): JsonRpcResponse {
    if (this.currentPhase !== 'fresh') {
      this.log('refusing a second initialize');
      return errorResponse(request.id, {
        code: INVALID_REQUEST,
        message: 'Invalid Request: Server already initialized',
      });
    }
    const read = requestParams(request);
    if (!read.ok) {
      return errorResponse(request.id, read.error);
    }
    const requested = read.params['protocolVersion'];
    if (typeof requested !== 'string') {
      return errorResponse(request.id, {
        code: INVALID_PARAMS,
        message: 'Invalid params: "protocolVersion" is missing or is not a string',
      });
    }
    // The client's capabilities and its own name are read by nothing here, so a wrongly shaped
    // one is reported and a missing one is not: refusing a request over a field no decision
    // depends on would be this server inventing a requirement.
    for (const name of ['capabilities', 'clientInfo']) {
      const value = read.params[name];
      if (value !== undefined && !isRecord(value)) {
        return errorResponse(request.id, {
          code: INVALID_PARAMS,
          message: `Invalid params: "${name}" is not an object`,
        });
      }
    }
    this.currentPhase = 'initializing';
    const negotiated = negotiateVersion(requested);
    this.log(`initialized on protocol ${negotiated} (client asked for ${requested})`);
    return result(request.id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: this.serverInfo.name, version: this.serverInfo.version },
      ...(this.instructions === undefined ? {} : { instructions: this.instructions }),
    });
  }

  /**
   * One page of tools, with no `nextCursor`: the specification requires a client to treat a
   * missing cursor as the end of the results, and there is no second page to hand one out for.
   * A cursor therefore arrives from a client that invented it or kept one from another server.
   */
  private listTools(request: JsonRpcRequest): JsonRpcResponse {
    const read = requestParams(request);
    if (!read.ok) {
      return errorResponse(request.id, read.error);
    }
    const cursor = read.params['cursor'];
    if (cursor !== undefined) {
      return errorResponse(request.id, {
        code: INVALID_PARAMS,
        message:
          typeof cursor === 'string'
            ? 'Invalid params: this server lists every tool in one page and issued no cursor'
            : 'Invalid params: "cursor" is not a string',
      });
    }
    const tools: readonly ToolDescription[] = this.registry.list();
    return result(request.id, { tools });
  }

  private async callTool(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const read = requestParams(request);
    if (!read.ok) {
      return errorResponse(request.id, read.error);
    }
    const name = read.params['name'];
    if (typeof name !== 'string' || name === '') {
      return errorResponse(request.id, {
        code: INVALID_PARAMS,
        message: 'Invalid params: "name" is missing or is not a tool name',
      });
    }
    const args = read.params['arguments'];
    if (args !== undefined && !isRecord(args)) {
      return errorResponse(request.id, {
        code: INVALID_PARAMS,
        message: 'Invalid params: "arguments" is not an object',
      });
    }
    const outcome = await this.registry.call(name, args ?? {});
    switch (outcome.kind) {
      case 'called':
        return result(request.id, outcome.result);
      case 'unknownTool':
        // A tool that is not there is a *protocol* error and not a result carrying `isError`,
        // which is what an execution failure of a tool that does exist answers with.
        this.log(`refusing an unknown tool: ${name}`);
        return errorResponse(request.id, {
          code: INVALID_PARAMS,
          message: `Invalid params: no tool named "${name}"`,
        });
      case 'invalidArguments':
        return errorResponse(request.id, {
          code: INVALID_PARAMS,
          message: `Invalid params for "${name}": ${outcome.problems.join('; ')}`,
          data: { problems: outcome.problems },
        });
      case 'failed':
        // The tool threw. That is this server's fault and not the caller's, and the caller can do
        // nothing with it, so it is an internal error rather than an in-band result.
        this.log(`tool ${name} failed: ${outcome.reason}`);
        return errorResponse(request.id, {
          code: INTERNAL_ERROR,
          message: `Internal error: ${name} failed`,
        });
    }
  }
}
