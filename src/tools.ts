/**
 * The tool surface an agent drives: nine tools over one `Session`, with the schemas and the prose
 * that tell a caller what each one does and where it stops.
 *
 * The descriptions are the front door — an agent picks a tool by reading one — so they say the
 * limits rather than implying a room holds a folder. Two of those limits are worth naming here,
 * because a description that hid either would be a lie: the listing is what the host walked when
 * the room opened and nothing republishes it, and a host cannot create a file its folder does not
 * already hold.
 *
 * Everything a caller did wrong comes back as a result carrying `isError: true`, because that is
 * what an agent can see and correct. An argument set that does not fit a tool never reaches a
 * handler: the registry checks it against the tool's own `inputSchema` first, and that one is a
 * protocol error. Every `SessionRefused` code is said in the one table below, so no internal code
 * has to survive into prose an agent reads.
 */

import { stat } from 'node:fs/promises';

import { SessionRefused } from './session.ts';
import type { Participant, Session, SessionRefusal, SessionStatus } from './session.ts';
import type { CallToolResult, ToolDefinition } from './registry.ts';
import type { JsonSchema } from './schema.ts';

/** What a host's server address falls back to when the tool argument is absent. */
export const SERVER_URL_VARIABLE = 'SELVAGE_SERVER_URL';

/** What a display name falls back to before the fixed one below. */
export const DISPLAY_NAME_VARIABLE = 'SELVAGE_DISPLAY_NAME';

/** The display name a seat gets when neither the argument nor the variable names one. */
export const DEFAULT_DISPLAY_NAME = 'agent';

/** What a host's or a joiner's cursor publication falls back to when the argument is absent. */
export const PUBLISH_CURSOR_VARIABLE = 'SELVAGE_PUBLISH_CURSOR';

/** How many paths `list_paths` answers with when the caller names no limit. */
export const DEFAULT_PATH_LIMIT = 100;

/** The largest limit `list_paths` accepts, so that no caller can ask for an unbounded answer. */
export const MAX_PATH_LIMIT = 1000;

type Environment = Readonly<Record<string, string | undefined>>;

function answer(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Every `SessionRefused` code in the words a caller reads. The code is the adapter's contract and
 * not something an agent can act on, so the sentence goes first and the adapter's own detail
 * follows it; nothing here shows a code raw.
 */
const REFUSALS: Readonly<Record<SessionRefusal, string>> = {
  busy: 'this server already holds a session',
  'no-session': 'there is no live session',
  'not-a-server': 'that is not a session address',
  'join-failed': 'the join did not go through',
  'host-failed': 'the host did not come up',
  'no-invite': 'that invite carries no usable room',
  'not-granted': 'the room granted no such path',
  missing: 'it is not in the room or in the folder',
  'not-a-file': 'that is not a plain file the grant will read',
  'too-large': 'it is over the size a session carries',
  binary: 'it is not text',
  'read-only': 'this seat is a viewer, which publishes no edit',
  'bad-change': 'that change does not fit the document',
  'room-error': 'the room refused it',
  'write-failed': 'the host folder refused the write',
  'timed-out': 'the room did not send it in time',
};

function refused(error: SessionRefused): CallToolResult {
  return failure(`${REFUSALS[error.code]}: ${error.message}`);
}

/**
 * Runs a handler, turning a refusal into the caller's own mistake, said readably. Anything else is
 * a fault in this server: it propagates to the registry, which answers it as an internal error
 * rather than as something the caller could have fixed.
 */
async function guarded(work: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await work();
  } catch (error: unknown) {
    if (error instanceof SessionRefused) {
      return refused(error);
    }
    throw error;
  }
}

/** Whether a host's folder is there and a directory, which the walk itself would not say kindly. */
async function folderProblem(root: string): Promise<string | undefined> {
  let kind: 'directory' | 'file' | 'absent';
  try {
    const info = await stat(root);
    kind = info.isDirectory() ? 'directory' : 'file';
  } catch {
    kind = 'absent';
  }
  if (kind === 'directory') {
    return undefined;
  }
  return kind === 'absent'
    ? `there is no folder at ${JSON.stringify(root)}`
    : `${JSON.stringify(root)} is not a folder`;
}

function argText(args: Readonly<Record<string, unknown>>, name: string): string {
  return args[name] as string;
}

function optionalText(args: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function optionalInteger(args: Readonly<Record<string, unknown>>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' ? value : undefined;
}

function displayName(args: Readonly<Record<string, unknown>>, env: Environment): string {
  return optionalText(args, 'display_name') ?? env[DISPLAY_NAME_VARIABLE] ?? DEFAULT_DISPLAY_NAME;
}

/**
 * The values the cursor variable is on for. A variable is a string, so a boolean option that
 * takes one has to say which strings mean yes; everything else, an empty value included, is off.
 */
const TRUE_VALUES: readonly string[] = ['1', 'true', 'yes', 'on'];

/**
 * Whether this seat publishes a cursor: the argument, then the variable, then off. An argument
 * beats the variable, an explicit `false` included.
 */
function publishCursor(args: Readonly<Record<string, unknown>>, env: Environment): boolean {
  const value = args['publish_cursor'];
  if (typeof value === 'boolean') {
    return value;
  }
  const variable = env[PUBLISH_CURSOR_VARIABLE];
  return variable !== undefined && TRUE_VALUES.includes(variable.trim().toLowerCase());
}

function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** One participant, as a line: who, which role, whether this connection, whether a cursor is up. */
function seat(participant: Participant): string {
  const marks = [
    participant.role,
    ...(participant.self ? ['this connection'] : []),
    ...(participant.aware ? ['publishes a cursor'] : ['no cursor seen']),
  ];
  return `${participant.displayName} (${marks.join(', ')})`;
}

/** The `publish_cursor` argument both session tools carry, so the two say the same thing. */
const PUBLISH_CURSOR_ARGUMENT: JsonSchema = {
  type: 'boolean',
  description: `Whether this seat publishes a cursor for the path each read, edit and write touches, so another seat can see which file this agent is working in and where. Off by default; the ${PUBLISH_CURSOR_VARIABLE} variable is the fallback.`,
};

function hostTool(session: Session, env: Environment): ToolDefinition {
  return {
    name: 'session_host',
    description:
      "Share a folder with a room and host it. The folder is walked once, here: the paths the walk finds are the room's listing, and only a file the folder holds at that moment can be listed, so a file that appears in the folder later is not listed until a new session, because nothing republishes the listing — and a host cannot create a file its folder does not already hold. Answers with the room id, the number of granted paths, and the complete invite URL including the key in its fragment, which is a credential for whoever should join. A host leaving closes the room for everyone. Takes the folder, the server address, a display name, and whether to publish a cursor.",
    inputSchema: objectSchema(
      {
        folder: {
          type: 'string',
          description: 'The folder to share, as the path this server should read it by.',
        },
        server_url: {
          type: 'string',
          description: `The Selvage server's address, such as ws://127.0.0.1:8080. Falls back to the ${SERVER_URL_VARIABLE} variable.`,
        },
        display_name: {
          type: 'string',
          description: `The name this seat shows in the room. Falls back to the ${DISPLAY_NAME_VARIABLE} variable, then to "${DEFAULT_DISPLAY_NAME}".`,
        },
        publish_cursor: PUBLISH_CURSOR_ARGUMENT,
      },
      ['folder'],
    ),
    async handler(args) {
      return await guarded(async () => {
        const folder = argText(args, 'folder');
        const problem = await folderProblem(folder);
        if (problem !== undefined) {
          return failure(problem);
        }
        const serverUrl = optionalText(args, 'server_url') ?? env[SERVER_URL_VARIABLE];
        if (serverUrl === undefined || serverUrl === '') {
          return failure(
            `hosting needs the server's address: pass "server_url" or set the ${SERVER_URL_VARIABLE} variable`,
          );
        }
        const hosted = await session.host({
          root: folder,
          serverUrl,
          displayName: displayName(args, env),
          publishCursor: publishCursor(args, env),
        });
        const cut =
          hosted.cut === undefined
            ? ''
            : ` (the walk stopped at its ${String(hosted.cut)} bound, so the folder is not fully listed)`;
        return answer(
          [
            `hosting room ${hosted.roomId} as ${hosted.role}, with ${hosted.paths.length} granted path(s)${cut}.`,
            `invite: ${hosted.inviteUrl}`,
            `participants: ${hosted.participants.length}`,
          ].join('\n'),
        );
      });
    },
  };
}

function joinTool(session: Session, env: Environment): ToolDefinition {
  return {
    name: 'session_join',
    description:
      "Join a room from an invite URL, which has to carry the key in its fragment. Answers with the room id, this seat's role, the participants and how many paths the host granted. The listing is what the host shared when the room opened, so a path shared afterwards is not in it until a new session. A guest edits the room's shared text and writes nothing to its own disk. Takes the invite, a display name, and whether to publish a cursor.",
    inputSchema: objectSchema(
      {
        invite: {
          type: 'string',
          description:
            'The invite URL a host handed out, fragment and all. That fragment is a credential.',
        },
        display_name: {
          type: 'string',
          description: `The name this seat shows in the room. Falls back to the ${DISPLAY_NAME_VARIABLE} variable, then to "${DEFAULT_DISPLAY_NAME}".`,
        },
        publish_cursor: PUBLISH_CURSOR_ARGUMENT,
      },
      ['invite'],
    ),
    async handler(args) {
      return await guarded(async () => {
        const joined = await session.join({
          invite: argText(args, 'invite'),
          displayName: displayName(args, env),
          publishCursor: publishCursor(args, env),
        });
        return answer(
          [
            `joined room ${joined.roomId} as ${joined.role}, with ${joined.pathCount} granted path(s).`,
            `participants: ${joined.participants.length}`,
            ...joined.participants.map((participant) => `  ${seat(participant)}`),
          ].join('\n'),
        );
      });
    },
  };
}

/** The session as a caller reads it, one fact per line. */
function report(status: SessionStatus): string {
  const lines = [
    `room: ${status.roomId}`,
    `role: ${status.role}`,
    `mode: ${status.mode}`,
    `live: ${
      status.live
        ? 'yes'
        : 'no (the connection dropped or the room ended; the session is still held and may come back)'
    }`,
    `granted paths: ${status.paths.length}`,
    `open documents: ${status.documents.length === 0 ? 'none' : status.documents.join(', ')}`,
    `participants: ${status.participants.length}`,
    ...status.participants.map((participant) => `  ${seat(participant)}`),
  ];
  if (status.cut !== undefined) {
    lines.push(
      `the host's walk stopped at its ${String(status.cut)} bound, so the listing is short of the folder`,
    );
  }
  lines.push(
    status.problems.length === 0
      ? 'problems: none'
      : `problems: ${status.problems.length}\n${status.problems
          .map((problem) => `  ${problem.path ?? '(no path)'}: ${REFUSALS[problem.cause]}`)
          .join('\n')}`,
  );
  return lines.join('\n');
}

function statusTool(session: Session): ToolDefinition {
  return {
    name: 'session_status',
    description:
      "Report the live session: role, room, mode, participants, whether the connection is carrying traffic, the granted paths this replica holds, the room's open documents, and any problem the session could not fix (a room change a host could not put on disk, a granted path the folder would not read). With no session open it still answers, saying there is none, rather than failing: asking where this server stands is not a mistake.",
    inputSchema: objectSchema({}),
    handler() {
      if (!session.hasSession()) {
        return answer('no session: this server is not in a room. Host a folder or join an invite.');
      }
      return answer(report(session.status()));
    },
  };
}

function leaveTool(session: Session): ToolDefinition {
  return {
    name: 'session_leave',
    description:
      'Leave the room this server is in, closing the connection and freeing the session so it can host or join again. A host leaving closes the room for everyone: the other seats are disconnected and the room ends, and the only way back is to host again or to join another invite. With no session it is a caller error, because there is nothing to leave.',
    inputSchema: objectSchema({}),
    async handler() {
      return await guarded(async () => {
        await session.leave();
        return answer('left the room: this server holds no session now.');
      });
    },
  };
}

/** The sorted, prefix-filtered, bounded answer to `list_paths`. */
function listPaths(session: Session, args: Readonly<Record<string, unknown>>): CallToolResult {
  const limit = optionalInteger(args, 'limit') ?? DEFAULT_PATH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    return failure('"limit" has to be a whole number of paths, at least 1');
  }
  if (limit > MAX_PATH_LIMIT) {
    return failure(
      `"limit" is above the ${MAX_PATH_LIMIT} paths this tool answers with at most`,
    );
  }
  const prefix = optionalText(args, 'prefix') ?? '';
  const matching = [...session.grantedPaths()].filter((path) => path.startsWith(prefix)).sort();
  if (matching.length === 0) {
    return answer(
      prefix === ''
        ? 'the room granted no paths'
        : `no granted path starts with ${JSON.stringify(prefix)}`,
    );
  }
  const shown = matching.slice(0, limit);
  const lines = [...shown];
  if (matching.length > shown.length) {
    lines.push(
      `(truncated: showing ${shown.length} of the ${matching.length} granted paths that match; raise "limit" to at most ${MAX_PATH_LIMIT}, or narrow "prefix")`,
    );
  }
  return answer(lines.join('\n'));
}

function listPathsTool(session: Session): ToolDefinition {
  return {
    name: 'list_paths',
    description:
      `List the paths the room's grant names, sorted, optionally filtered by a prefix and capped at ${DEFAULT_PATH_LIMIT} unless a higher limit is asked for (at most ${MAX_PATH_LIMIT}). The listing is what the host walked when the room opened and is not live: a file the folder gained since is not in it, and one the folder lost still is, until a new session. A truncated answer says so and names the limit. Takes the optional prefix and limit.`,
    inputSchema: objectSchema({
      prefix: { type: 'string', description: 'Answer only with paths starting with this text.' },
      limit: {
        type: 'integer',
        description: `How many paths to answer with, at most ${MAX_PATH_LIMIT}. Defaults to ${DEFAULT_PATH_LIMIT}.`,
      },
    }),
    async handler(args) {
      return await guarded(async () => listPaths(session, args));
    },
  };
}

function readFileTool(session: Session): ToolDefinition {
  return {
    name: 'read_file',
    description:
      "Read one granted path's shared text as the room holds it. Only a path the room's grant names can be read; a path that is not text, or is over the size a session carries, is refused rather than answered. The text is the room's — the host folder's copy where the host is keeping that true — and this tool never reads the disk itself. A guest waits for the room to send the document and is refused if it does not arrive in time.",
    inputSchema: objectSchema(
      { path: { type: 'string', description: 'A granted path, as list_paths spells it.' } },
      ['path'],
    ),
    async handler(args) {
      return await guarded(async () => {
        const shared = await session.read(argText(args, 'path'));
        return answer(shared.text);
      });
    },
  };
}

/**
 * How many positions in `hay` spell `needle`, counting overlapping matches as separate ones:
 * `'aa'` is in `'aaa'` twice. This is the count that decides whether an edit is ambiguous,
 * because either position is a place the caller's text could have meant.
 */
function matchCount(hay: string, needle: string): number {
  let count = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = hay.indexOf(needle, at + 1);
  }
  return count;
}

/**
 * The occurrences a `split`/`join` replacement touches, which never overlap: `'aaa'` holds one
 * `'aa'` for a `replace_all`, and two for `matchCount`. This is the count an answer reports.
 */
function occurrencesOf(hay: string, needle: string): number {
  let count = 0;
  let at = hay.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = hay.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * What the edit should hold and how much of the text it replaced, or the reason to refuse.
 * `replacements: 0` is an edit that would put back exactly what it took out.
 */
type Wanted =
  | { readonly text: string; readonly replacements: number }
  | { readonly refusal: string };

function wantedText(hay: string, old: string, replacement: string, all: boolean): Wanted {
  if (old === '') {
    return { refusal: '"old_string" is empty: an edit needs the text it should replace' };
  }
  const occurrences = matchCount(hay, old);
  if (occurrences === 0) {
    return {
      refusal: `"old_string" does not appear in the document as the room holds it (${hay.length} characters)`,
    };
  }
  if (occurrences > 1 && !all) {
    return {
      refusal: `"old_string" appears ${occurrences} times: give a longer, unique "old_string", or set "replace_all": true to replace all ${occurrences}`,
    };
  }
  if (all) {
    const text = hay.split(old).join(replacement);
    return { text, replacements: text === hay ? 0 : occurrencesOf(hay, old) };
  }
  const at = hay.indexOf(old);
  const text = hay.slice(0, at) + replacement + hay.slice(at + old.length);
  return { text, replacements: text === hay ? 0 : 1 };
}

function editFileTool(session: Session): ToolDefinition {
  return {
    name: 'edit_file',
    description:
      'Replace "old_string" with "new_string" in one granted path\'s shared text. Refuses, changing nothing, when "old_string" does not appear, and when it appears more than once unless "replace_all" is true: an ambiguous edit is never guessed at. Only the changed range is published to the room, and a viewer\'s edit is refused. A host\'s own folder follows the room, but this cannot create a file the folder does not already hold.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', description: 'A granted path, as list_paths spells it.' },
        old_string: {
          type: 'string',
          description: 'The exact text to replace, including its whitespace.',
        },
        new_string: { type: 'string', description: 'The text to put in its place.' },
        replace_all: {
          type: 'boolean',
          description:
            'Replace every occurrence instead of refusing when "old_string" is ambiguous. Defaults to false.',
        },
      },
      ['path', 'old_string', 'new_string'],
    ),
    async handler(args) {
      return await guarded(async () => {
        const path = argText(args, 'path');
        const old = argText(args, 'old_string');
        const replacement = argText(args, 'new_string');
        const all = args['replace_all'] === true;
        // The text to replace is the replica's own as the hold finds it, and the replacement is
        // worked out there: a change computed from a read taken first is a change applied to
        // whatever range that read's offsets point at by the time it lands, which is a document
        // that has moved. A caller's `old_string` that the live text does not hold is that
        // caller's own mistake, and it is refused as one.
        let replacements = 0;
        const outcome = await session.transform(path, (live) => {
          const wanted = wantedText(live, old, replacement, all);
          if ('refusal' in wanted) {
            throw new SessionRefused('bad-change', wanted.refusal);
          }
          replacements = wanted.replacements;
          return wanted.text;
        });
        if (replacements === 0) {
          return answer(`no change to ${path}: the document already holds that text`);
        }
        const disk = outcome.disk === 'none' ? '' : `; the host's folder: ${outcome.disk}`;
        return answer(
          `edited ${path}: ${replacements} replacement(s), ${outcome.length} characters now${disk}`,
        );
      });
    },
  };
}

function writeFileTool(session: Session): ToolDefinition {
  return {
    name: 'write_file',
    description:
      'Replace a granted path\'s whole shared text with "content". This is how a host changes a file its folder already holds: the folder follows the room, but a file the folder does not hold cannot be created, and a path the room did not grant cannot be written at all. A viewer is refused, and text over the size a session carries is refused. Prefer edit_file where a small change is meant.',
    inputSchema: objectSchema(
      {
        path: { type: 'string', description: 'A granted path, as list_paths spells it.' },
        content: { type: 'string', description: 'The whole text the path should hold.' },
      },
      ['path', 'content'],
    ),
    async handler(args) {
      return await guarded(async () => {
        const path = argText(args, 'path');
        const outcome = await session.write(path, argText(args, 'content'));
        const disk = outcome.disk === 'none' ? '' : `; the host's folder: ${outcome.disk}`;
        return answer(`wrote ${path}: ${outcome.length} characters in the room${disk}`);
      });
    },
  };
}

function participantsTool(session: Session): ToolDefinition {
  return {
    name: 'list_participants',
    description:
      'List the seats in the room: each display name, its role, whether it is this connection, and whether a cursor is published. This server publishes one only when a session was opened with "publish_cursor", so its own seat shows a cursor only then; otherwise presence is only what peers say. The roster is as current as the last event from the room, so a seat that has just arrived or left may still be reported as it was.',
    inputSchema: objectSchema({}),
    async handler() {
      return await guarded(async () => {
        const rows = session.participants();
        if (rows.length === 0) {
          return answer('no participants recorded');
        }
        return answer(rows.map((participant) => seat(participant)).join('\n'));
      });
    },
  };
}

/** Every tool this server offers, over one session, in the order an agent reads them. */
export function createSessionTools(
  session: Session,
  env: Environment = process.env,
): readonly ToolDefinition[] {
  return [
    hostTool(session, env),
    joinTool(session, env),
    statusTool(session),
    leaveTool(session),
    listPathsTool(session),
    readFileTool(session),
    editFileTool(session),
    writeFileTool(session),
    participantsTool(session),
  ];
}
