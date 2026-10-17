/**
 * Room activity as an MCP notification: the framing, the level a client may set, and the one
 * place a message this server was not asked for reaches stdout.
 *
 * `notifications/message` is the specification's own server-to-client channel for something a
 * client did not ask for (`2025-11-25/server/utilities/logging.mdx`), which is what a room
 * moving is. The capability is declared with the tools one, the payload is structured, and the
 * level is always `info` — a change in a shared document is not a warning. A client that sets a
 * higher level with `logging/setLevel` is honoured: this server says nothing below it.
 *
 * Nothing here ever carries the invite. An activity is a path, a bounded hunk, a length, or a
 * roster; the room's key is not one of those, and this module could not render it if it were.
 */

import type { JsonRpcNotification } from './jsonrpc.ts';
import type { Activity } from './session.ts';

/** The levels `2025-11-25` names, most verbose first, in the order severity rises. */
export const LOG_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** What the server hands a client's `logging/setLevel` to. */
export interface LoggingControl {
  setLevel(level: LogLevel): void;
}

/** Where an activity goes once the transport can write. */
export interface ActivitySink {
  (message: JsonRpcNotification): void;
}

/**
 * The channel a session's activity goes through: it drops until a transport attaches a sink,
 * frames one activity as one `notifications/message`, and honours the level a client set.
 */
export class ActivityChannel implements LoggingControl {
  private sink: ActivitySink | undefined;
  private minimum: number | undefined;

  /** Called by the transport once, with a way to write in the same order as responses. */
  attach(sink: ActivitySink): void {
    this.sink = sink;
  }

  setLevel(level: LogLevel): void {
    this.minimum = LOG_LEVELS.indexOf(level);
  }

  deliver(activity: Activity): void {
    const sink = this.sink;
    if (sink === undefined) {
      return;
    }
    // Every activity is `info`; a client that asked for `warning` and above hears none of them.
    if (this.minimum !== undefined && LOG_LEVELS.indexOf('info') < this.minimum) {
      return;
    }
    sink({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', logger: 'selvage', data: payload(activity) },
    });
  }
}

/** One activity as the `data` a client reads, bounded by what the session already cut. */
function payload(activity: Activity): Record<string, unknown> {
  if (activity.kind === 'document') {
    return {
      selvage: 'document',
      path: activity.path,
      length: activity.length,
      appeared: activity.appeared,
      truncated: activity.truncated,
      hunk: [...activity.hunk],
    };
  }
  return { selvage: 'peers', joined: [...activity.joined], left: [...activity.left] };
}
