/**
 * The stdio transport: newline-delimited JSON-RPC 2.0 in on stdin, the same out on stdout, and
 * nothing else on either.
 *
 * `2025-11-25/basic/transports.mdx` is exact about both halves. Messages are "delimited by
 * newlines, and MUST NOT contain embedded newlines" — there is no `Content-Length` header and no
 * other framing — the server "MUST NOT write anything to its `stdout` that is not a valid MCP
 * message", and it must not write *requests* there either, because on stdio the client is the only
 * one that asks. So this file writes responses and nothing else, and every diagnostic goes to
 * stderr, where the same page allows a server to write strings a client may ignore.
 *
 * The reference client's parser is what the framing has to satisfy: it collects bytes and only
 * emits on a `\n`, tolerating a `\r` before it, so one message is one `JSON.stringify(...)` plus
 * `\n` — never pretty-printed, never missing its newline. A final line with no newline is a
 * message that was never delimited and is dropped unread, which is what that parser does with it.
 */

import { PARSE_ERROR, encode, errorResponse, parseLine } from './jsonrpc.ts';
import type { JsonRpcMessage } from './jsonrpc.ts';
import type { Server } from './server.ts';
import type { Readable, Writable } from 'node:stream';

/**
 * How long a line may be before this server drops it rather than buffer it. There is no bound in
 * the specification; the reference client's own parser drops anything past 10 MB, so a client
 * using it cannot send more than that, and this leaves room for one that does not.
 */
export const MAX_STDIO_LINE_BYTES = 16 * 1024 * 1024;

/** Reads newline-delimited lines off a text stream. */
export class LineReader {
  // The chunks of the line being collected, none of which holds a newline, joined once when the
  // newline that ends it arrives: a chunk may split a multi-byte character or a message anywhere.
  private pending: string[] = [];
  // The line in UTF-8 bytes, counted as chunks land rather than re-scanned whole: a CJK line is
  // three times what `String.length` says, and the bound has to hold for it too.
  private pendingBytes = 0;
  private dropping = false;
  private readonly onLine: (line: string) => void;
  private readonly onDrop: (bytes: number) => void;

  constructor(onLine: (line: string) => void, onDrop: (bytes: number) => void) {
    this.onLine = onLine;
    this.onDrop = onDrop;
  }

  push(chunk: string): void {
    let from = 0;
    let newline = chunk.indexOf('\n');
    while (newline !== -1) {
      this.finish(chunk.slice(from, newline));
      from = newline + 1;
      newline = chunk.indexOf('\n', from);
    }
    this.collect(from === 0 ? chunk : chunk.slice(from));
  }

  private collect(piece: string): void {
    if (piece === '' || this.dropping) {
      return;
    }
    this.pending.push(piece);
    this.pendingBytes += Buffer.byteLength(piece, 'utf8');
    if (this.pendingBytes > MAX_STDIO_LINE_BYTES) {
      const bytes = this.pendingBytes;
      this.dropping = true;
      this.pending = [];
      this.pendingBytes = 0;
      this.onDrop(bytes);
    }
  }

  private finish(piece: string): void {
    // A `\r` before the newline is what the reference client tolerates, and it is not part of a
    // message: it is dropped without being told about, because nothing is wrong with the line.
    const piece_ = piece.endsWith('\r') ? piece.slice(0, -1) : piece;
    if (this.dropping) {
      this.dropping = false;
      return;
    }
    const line = this.pending.join('') + piece_;
    const lineBytes = this.pendingBytes + Buffer.byteLength(piece, 'utf8');
    this.pending = [];
    this.pendingBytes = 0;
    if (lineBytes > MAX_STDIO_LINE_BYTES) {
      // One line past the bound that arrived in fewer chunks than it takes to shed it.
      this.onDrop(lineBytes);
      return;
    }
    if (line.trim() !== '') {
      this.onLine(line);
    }
  }
}

/** Writes one message per line, in the order it was handed them. */
class StreamWriter {
  private readonly output: Writable;
  private queue: Promise<void> = Promise.resolve();

  constructor(output: Writable) {
    this.output = output;
  }

  /**
   * One message at a time, in the order this was handed them. The write callback is what orders
   * it: it fires when the chunk is flushed, so the next `output.write` is not reached until this
   * one has left, and two handlers finishing at once cannot land inside one line. The queue is
   * what an unsolicited notification goes through too, so a notification emitted while a response
   * is on its way is still one whole line on the stream.
   */
  write(message: JsonRpcMessage): Promise<void> {
    const line = encode(message);
    const next = this.queue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.output.write(line, (error) => {
            if (error === null || error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    );
    // A failed write is reported to the caller that awaits it; the chain itself keeps going so
    // that one closed pipe does not leave the messages behind it unreported too.
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export interface TransportIO {
  readonly input: Readable;
  readonly output: Writable;
  /** Where a message this server would not answer, or could not, is reported. Never stdout. */
  readonly diagnostic: (message: string) => void;
  /**
   * Called once, with a way to write an unsolicited message in the same order as responses, so a
   * session can tell its client about the room without being asked. The write goes through the
   * same queue as a response and never carries a request.
   */
  readonly onWriter?: (write: (message: JsonRpcMessage) => void) => void;
}

/**
 * Answers every message on `input` until it ends, then returns. Each message is dispatched as its
 * own task rather than awaited in the read loop, which is what lets a request that blocks — a
 * `wait_for_change` held to its deadline — be answered beside another rather than in front of it.
 * Dispatch itself is still in arrival order, so the lifecycle gate sees an `initialize` before the
 * messages that follow it, and the ordering beyond that is the session's own: `Session` serializes
 * its mutations, per path and as a whole, so two edits cannot interleave into a torn document.
 *
 * End of input *is* the shutdown: `2025-11-25/basic/lifecycle.mdx` has the client close stdin and
 * then wait for the process to exit, so returning here — with every task it still owned finished
 * and every write it still owned flushed — is the whole of it.
 */
export async function serve(server: Server, io: TransportIO): Promise<void> {
  const writer = new StreamWriter(io.output);
  io.onWriter?.((message) => {
    void writer.write(message).catch((error: unknown) => {
      io.diagnostic(`writing a notification: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  // Every task started here, so that the return below cannot leave one in flight. A rejected task
  // is remembered rather than thrown from an event handler, and reported once the loop is done.
  const outstanding = new Set<Promise<void>>();
  let failure: unknown;

  const run = (work: () => Promise<void>): void => {
    const started = Promise.resolve()
      .then(work)
      .catch((error: unknown) => {
        if (failure === undefined) {
          failure = error;
        }
      });
    outstanding.add(started);
    void started.then(() => {
      outstanding.delete(started);
    });
  };

  const handleLine = async (line: string): Promise<void> => {
    const parsed = parseLine(line);
    switch (parsed.kind) {
      case 'fault':
        io.diagnostic(`refusing a malformed message: ${parsed.error.message}`);
        await writer.write(errorResponse(parsed.id, parsed.error));
        return;
      case 'unsolicited':
        io.diagnostic(`ignoring ${parsed.reason}`);
        return;
      case 'notification':
        server.notify(parsed.notification);
        return;
      case 'request':
        await writer.write(await server.answer(parsed.request));
        return;
    }
  };

  await new Promise<void>((done, failed) => {
    const reader = new LineReader(
      (line) => {
        run(() => handleLine(line));
      },
      (bytes) => {
        // A line past the bound is no more readable than one that is not JSON, and the id it
        // carried was thrown away with it: `2025-11-25/basic/index.mdx` allows an error response
        // to omit `id` where the id could not be read, and `null` is not an id MCP allows.
        io.diagnostic(`dropping a line of ${bytes} bytes with no newline past the bound`);
        run(() =>
          writer.write(
            errorResponse(undefined, {
              code: PARSE_ERROR,
              message: `Parse error: the message is longer than ${MAX_STDIO_LINE_BYTES} bytes and was not read`,
            }),
          ),
        );
      },
    );
    io.input.setEncoding('utf8');
    io.input.on('data', (chunk: string) => {
      reader.push(chunk);
    });
    io.input.on('end', done);
    io.input.on('error', failed);
  });

  // Every task started here is awaited before returning, so nothing this process owned is still
  // in flight when the client's close ends it. The set is re-read rather than trusted as one
  // snapshot; nothing here starts a task from inside another, so it cannot spin.
  for (;;) {
    const pending = [...outstanding];
    if (pending.length === 0) {
      break;
    }
    await Promise.all(pending);
  }
  if (failure !== undefined) {
    throw failure;
  }
}
