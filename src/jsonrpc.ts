/**
 * The JSON-RPC 2.0 vocabulary as MCP uses it, and the reading of one line of it.
 *
 * The differences from plain JSON-RPC are the ones that break a hand-rolled server, so they are
 * held here rather than in the loop that reads:
 *
 * - Requests are the only messages a client sends that expect an answer. `id` is `string |
 *   integer` and **never** `null`, so a message with `method` and `id: null` is not a
 *   notification with an odd id — it is malformed, and the id it names is not one this server can
 *   echo.
 * - A message that arrived as valid JSON this server cannot read — `jsonrpc` missing, `method` a
 *   number, no `method` and no `result` — answers `-32600`; one that is not JSON at all answers
 *   `-32700`. `2025-06-18` removed JSON-RPC batching, so a top-level array is neither.
 * - An error response whose id could not be read omits `id` rather than sending `null`, which is
 *   what `2025-11-25/basic/index.mdx` allows and what the SDK's own client schema accepts.
 */

/** The id of a request, echoed back verbatim. `null` is not one. */
export type RequestId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcResultResponse {
  readonly jsonrpc: '2.0';
  readonly id: RequestId;
  readonly result: unknown;
}

/** An error response. `id` is absent where the message that caused it named no readable id. */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id?: RequestId;
  readonly error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * The codes this server emits. `-32700`…`-32603` are JSON-RPC's; `-32000` is the first of the
 * implementation-defined range, where `2025-11-25/basic/index.mdx` says the specification
 * "will never define codes", so the value the official server uses for a request that arrives
 * before initialization is ours to reuse — with its meaning, not with a code MCP owns.
 */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const NOT_INITIALIZED = -32000;

/** A response to `request`, or one to a notification this server had something to say about. */
export function result(id: RequestId, value: unknown): JsonRpcResultResponse {
  return { jsonrpc: '2.0', id, result: value };
}

/** An error response. `id` is passed through as it is, `undefined` to omit it. */
export function errorResponse(id: RequestId | undefined, error: JsonRpcError): JsonRpcErrorResponse {
  return id === undefined ? { jsonrpc: '2.0', error } : { jsonrpc: '2.0', id, error };
}

/**
 * One message, on one line, as the transport writes it. `JSON.stringify` escapes the newlines a
 * text block may carry, so a message never holds one of its own and never needs to be split.
 */
export function encode(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * What one input line turned out to be, or the error to answer it with.
 *
 * `unsolicited` is a response: this server sends no requests, so nothing it gets back can be
 * one. It carries what was seen for the diagnostic and is not answered at all — a response
 * cannot be replied to, and answering it as a request is how a loop between two peers starts.
 */
export type ParsedLine =
  | { readonly kind: 'request'; readonly request: JsonRpcRequest }
  | { readonly kind: 'notification'; readonly notification: JsonRpcNotification }
  | { readonly kind: 'unsolicited'; readonly reason: string }
  | { readonly kind: 'fault'; readonly error: JsonRpcError; readonly id?: RequestId };

/** Whether a JSON value is an id this protocol allows, and not a `null`, an array or a float. */
function isRequestId(value: unknown): value is RequestId {
  return (
    typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id a malformed message carried, where there is one worth echoing. */
function readableId(value: Record<string, unknown>): RequestId | undefined {
  return isRequestId(value['id']) ? value['id'] : undefined;
}

/**
 * What one line holds.
 *
 * The fault cases are separated by what can be read off the message: a line that is not JSON
 * yields no id, and one whose `id` is a `null`, a float or an object is a message naming an id
 * this server cannot echo, so its refusal carries none either. Everything else answers with the
 * id it came with, which is what a client matches a response to a request by.
 */
export function parseLine(line: string): ParsedLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error: unknown) {
    return {
      kind: 'fault',
      error: {
        code: PARSE_ERROR,
        message: `Parse error: ${error instanceof Error ? error.message : 'the line is not JSON'}`,
      },
    };
  }

  // `2025-06-18` removed batching: a JSON array is a message no revision in use accepts.
  if (Array.isArray(parsed)) {
    return {
      kind: 'fault',
      error: { code: INVALID_REQUEST, message: 'Invalid Request: batches are not part of MCP' },
    };
  }
  if (!isRecord(parsed)) {
    return {
      kind: 'fault',
      error: { code: INVALID_REQUEST, message: 'Invalid Request: the message is not an object' },
    };
  }

  const id = readableId(parsed);
  const malformed = (message: string): ParsedLine => ({
    kind: 'fault',
    error: { code: INVALID_REQUEST, message },
    ...(id === undefined ? {} : { id }),
  });

  if (parsed['jsonrpc'] !== '2.0') {
    return malformed('Invalid Request: the message does not say "jsonrpc": "2.0"');
  }

  const method = parsed['method'];
  if (method === undefined) {
    if (parsed['result'] !== undefined || parsed['error'] !== undefined) {
      const { result: replied } = parsed;
      return {
        kind: 'unsolicited',
        reason: `a response (id ${JSON.stringify(parsed['id'])}, ${'error' in parsed ? 'error' : `result ${JSON.stringify(replied)}`}) to a request this server never sent`,
      };
    }
    return malformed('Invalid Request: the message has neither a method nor a result');
  }
  if (typeof method !== 'string') {
    return malformed('Invalid Request: "method" is not a string');
  }

  if ('id' in parsed && !isRequestId(parsed['id'])) {
    return parsed['id'] === null
      ? malformed('Invalid Request: "id" is null, which no request may be')
      : malformed('Invalid Request: "id" is neither a string nor an integer');
  }
  // Carried as they arrived, and not as an object: a `params` that is an array, a string or a
  // `null` is the method's to refuse with `-32602`, not the transport's to drop.
  const carried = 'params' in parsed ? { params: parsed['params'] } : {};
  if (id === undefined) {
    return { kind: 'notification', notification: { jsonrpc: '2.0', method, ...carried } };
  }
  return { kind: 'request', request: { jsonrpc: '2.0', id, method, ...carried } };
}

/**
 * A request with its `params` read as the object a method expects, or the refusal to answer it
 * with. Params are absent from a well-formed request that carries none, and a method whose
 * params are all optional still refuses an array or a bare string rather than guessing.
 */
export function requestParams(
  request: JsonRpcRequest,
): { readonly ok: true; readonly params: Record<string, unknown> } | { readonly ok: false; readonly error: JsonRpcError } {
  if (request.params === undefined) {
    return { ok: true, params: {} };
  }
  if (!isRecord(request.params)) {
    return {
      ok: false,
      error: { code: INVALID_PARAMS, message: 'Invalid params: "params" is not an object' },
    };
  }
  return { ok: true, params: request.params };
}
