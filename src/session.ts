/**
 * The session an agent drives: hosting a folder, joining an invite, reading a granted path,
 * applying an edit — the adapter over the vendored sync engine.
 *
 * It is the counterpart of the Neovim companion's `Companion` (`nvim_client`), one editor down:
 * the engine decides the room, and everything here is what an adapter that has no editor — no
 * buffers, no mirror directory, no cursor to draw — still owes the room. The three places it
 * parts company with the companion, and why:
 *
 * - **No mirror.** A room is not materialised into a directory of its own. The companion does
 *   that for native editor tooling to read; an agent has no such tooling, so a mirror would be a
 *   second copy of the truth with no reader. A host writes to the folder it shares and a guest
 *   writes nothing at all.
 * - **A host applies the room's changes to its working copy.** A host whose disk silently
 *   diverged from the room would be lying to whoever opens that folder next, and an agent has no
 *   unsaved-buffer concept to hold the difference. See `applyFromRoom`.
 * - **Identity, not a cursor.** The display name is what a human sees who joined; no selection is
 *   ever published, because inventing one would put a cursor in someone's editor that no agent
 *   is looking through (`engine.md` §6).
 *
 * The invite's fragment is a credential: it is handed back to a host because that is its whole
 * purpose, and it is never logged, never written to a file and never put in a diagnostic.
 */

import { resolve } from 'node:path';

import { PeerEngine } from '../vendor/bridge/index.ts';
import {
  MAX_GRANT_FILE_BYTES,
  applyChange,
  diff,
  isGrantedPath,
  toCrdt,
} from '../vendor/bridge/index.ts';
import type { Engine, TextChange } from '../vendor/bridge/index.ts';
import { sessionBase } from '../vendor/engine/index.ts';
import type { EngineEvent, PeerInfo, Role } from '../vendor/engine/index.ts';
import { enumerateGrant, readGrantedFile, writeGrantedFile } from './grant.ts';
import type { GrantCut } from './grant.ts';

/**
 * Why a session refused to do what it was asked. The first four are the session's own state, the
 * `not-granted` group is the grant's ruling on a path (`GrantRefusal`), and the rest are the
 * engine's or the file system's answer.
 */
export type SessionRefusal =
  | 'busy'
  | 'no-session'
  | 'not-a-server'
  | 'join-failed'
  | 'host-failed'
  | 'no-invite'
  | 'not-granted'
  | 'missing'
  | 'not-a-file'
  | 'too-large'
  | 'binary'
  | 'read-only'
  | 'bad-change'
  | 'room-error'
  | 'write-failed'
  | 'timed-out';

/** A refusal with a code a tool layer can act on, rather than a message it has to parse. */
export class SessionRefused extends Error {
  readonly code: SessionRefusal;

  constructor(code: SessionRefusal, message: string) {
    super(message);
    this.name = 'SessionRefused';
    this.code = code;
  }
}

/**
 * The listing a host shares, read by the engine when it seals a state and replaced by the state
 * that follows. `grantedPaths()` on the engine answers the room's listing, which a guest learns
 * from the state; this is the host's own half of it — the folder as its own walk sees it.
 */
export interface SessionListing {
  current(): readonly string[];
  replace(paths: readonly string[]): void;
}

/** The engine's own surface, beyond the bridge's `Engine`: what an adapter needs of a session. */
export interface SessionEngine extends Engine {
  /** The wire invite with its fragment, for a host; `undefined` for a joiner. */
  inviteUrl(): string | undefined;
  disconnect(): Promise<void>;
  /** Ends the room for every seat; false when this connection is not the host. */
  closeRoom(): Promise<boolean>;
  rename(displayName: string): Promise<void>;
  /** Publishes a host's whole listing (`§7.1`). */
  grant(paths: readonly string[]): Promise<void>;
  /** The granted listing as this replica holds it. */
  grantedPaths(): string[];
}

export interface HostEngineOptions {
  /** A server base, in the one spelling `sessionBase` accepts. */
  readonly baseUrl: string;
  readonly displayName: string;
  readonly listing: SessionListing;
}

export interface JoinEngineOptions {
  /** The invite, either form, with its fragment. */
  readonly invite: string;
  readonly displayName: string;
}

/** What a session is opened with. A test hands in a stub and sees every call it makes. */
export interface EngineFactory {
  host(options: HostEngineOptions): Promise<SessionEngine>;
  join(options: JoinEngineOptions): Promise<SessionEngine>;
}

/**
 * The engine this adapter opens in production. `PeerEngine` is the bridge's own facade over a
 * `selvage/2` relay and satisfies `SessionEngine` as it stands, so a drift in that interface is
 * a compile error here rather than a surprise on a live server.
 */
export const realEngines: EngineFactory = {
  host: (options: HostEngineOptions) =>
    PeerEngine.host({
      baseUrl: options.baseUrl,
      displayName: options.displayName,
      listing: options.listing,
    }),
  join: (options: JoinEngineOptions) =>
    PeerEngine.join({ invite: options.invite, displayName: options.displayName }),
};

/** Which half of a session this process holds: the room's host, or a seat somebody invited. */
export type Mode = 'host' | 'guest';

/**
 * One seat as this replica sees it: the room's own record of a peer, plus whether it published
 * awareness. `aware` says the peer has a cursor somewhere, not where — this adapter never
 * publishes one of its own and has no business rendering another's.
 */
export interface Participant {
  readonly peerId: string;
  readonly displayName: string;
  readonly role: Role;
  readonly aware: boolean;
  /** Whether this is the connection this process holds. */
  readonly self: boolean;
}

/**
 * A refusal with no caller to hand it to: an incoming room change this host could not put on
 * disk, or a path the room asked for that the grant would not read. The session keeps the last
 * few so that `status` can report a host that has stopped keeping its folder true.
 */
export interface SessionProblem {
  readonly path: string | undefined;
  readonly cause: SessionRefusal;
  readonly message: string;
}

/** The room as this process holds it. */
export interface SessionStatus {
  readonly mode: Mode;
  /**
   * Whether the connection is carrying traffic. It is false once the session has seen a drop or
   * the room end (`reconnecting`, `disconnected`, `roomGone`) and true again as soon as an event
   * from the room arrives — this interface cannot see the socket itself, so it reports what the
   * room has said rather than what the transport is doing.
   */
  readonly live: boolean;
  readonly roomId: string;
  readonly role: Role;
  readonly participants: readonly Participant[];
  /** The granted listing as this replica holds it: the host's own walk, a guest's state. */
  readonly paths: readonly string[];
  /** The bound that left a host's own walk short of its folder, when one did. */
  readonly cut: GrantCut | undefined;
  /** The room's open-document set: the paths some seat is holding. */
  readonly documents: readonly string[];
  readonly problems: readonly SessionProblem[];
}

/** What hosting answered with. `inviteUrl` is the credential: it belongs to the caller. */
export interface HostedSession {
  readonly roomId: string;
  readonly role: Role;
  readonly inviteUrl: string;
  readonly paths: readonly string[];
  readonly cut: GrantCut | undefined;
  readonly participants: readonly Participant[];
}

/** What joining answered with: the room, this seat's role, and the grant as it arrived. */
export interface JoinedSession {
  readonly roomId: string;
  readonly role: Role;
  readonly participants: readonly Participant[];
  readonly paths: readonly string[];
  readonly pathCount: number;
}

export interface HostOptions {
  /** The folder to share. Everything under it is enumerated by the grant's own walk. */
  readonly root: string;
  /** The server's address, as a person spells it: `ws://`, `wss://`, `http://` or `https://`. */
  readonly serverUrl: string;
  readonly displayName: string;
}

export interface JoinOptions {
  /** The whole link, fragment and all. Without the fragment there is nothing to read a room with. */
  readonly invite: string;
  readonly displayName: string;
}

/** What a read of a granted path found in the room's text. */
export interface SharedText {
  readonly path: string;
  readonly text: string;
}

/** What an edit did to the room's document, and what the host's own folder got of it. */
export interface EditOutcome {
  readonly path: string;
  /** The document's length in UTF-16 code units after the edit, as the replica holds it. */
  readonly length: number;
  /**
   * `none` for a guest, which writes nothing to disk; for a host, what its working copy got —
   * `written`, `unchanged` because the folder already held that text, or `refused` because the
   * grant would not take the write, which is also recorded in `status().problems`.
   */
  readonly disk: 'none' | 'written' | 'unchanged' | 'refused';
}

export interface SessionOptions {
  /** The engine factory. Defaults to `realEngines`; a test hands in a stub. */
  readonly engines?: EngineFactory;
  /** How long a read or an edit waits for a document the room has not sent yet. */
  readonly documentWaitMs?: number;
  /** How long a join waits for the room's listing when the state names no documents. */
  readonly grantWaitMs?: number;
  /** How many problems `status` keeps. */
  readonly problemLimit?: number;
}

/** The host's own listing, as the engine reads it when it seals a state (`§7.1`). */
class Listing implements SessionListing {
  private paths: readonly string[] = [];

  current(): readonly string[] {
    return this.paths;
  }

  replace(paths: readonly string[]): void {
    this.paths = [...paths];
  }
}

/**
 * One live session per process.
 *
 * A second host or join while one is live is refused and the refusal names what is live, because
 * two sessions in one process is two answers to every question the tool layer asks — which room,
 * whose folder, whose role. Leaving frees the process for the next one.
 */
export class Session {
  private readonly engines: EngineFactory;
  private readonly documentWaitMs: number;
  private readonly grantWaitMs: number;
  private readonly problemLimit: number;
  private readonly listing = new Listing();
  private readonly problems: SessionProblem[] = [];
  /** The seed in flight per path, so a second ask for one joins it rather than reading again. */
  private readonly seeding = new Map<string, Promise<void>>();
  /** The write-back in flight per path, so two room changes for one path never write at once. */
  private readonly writing = new Map<string, Promise<void>>();

  private engine: SessionEngine | undefined;
  private mode: Mode | undefined;
  /** The folder a host shares. A guest has none, which is why a guest writes nothing. */
  private root: string | undefined;
  private cut: GrantCut | undefined;
  private live = false;

  constructor(options: SessionOptions = {}) {
    this.engines = options.engines ?? realEngines;
    this.documentWaitMs = options.documentWaitMs ?? 5_000;
    this.grantWaitMs = options.grantWaitMs ?? 250;
    this.problemLimit = options.problemLimit ?? 20;
  }

  /** Whether a session is live, which is what `host` and `join` refuse over. */
  hasSession(): boolean {
    return this.engine !== undefined;
  }

  /**
   * Hosts a folder: enumerates it through the grant's own walk, publishes that listing, and
   * reports the room and the invite that opens it.
   *
   * The listing is in the engine's hands before the room is minted, so the first state a seat
   * ever receives already names this folder (`§7.1`).
   *
   * An engine that will not open the room is refused `host-failed`, the way a join is: a server
   * this process cannot reach is the caller's own address, and it belongs in an answer the caller
   * can read rather than in a fault of this server. The address is taken out of both refusals,
   * because a caller may have spelled it as an invite and a refusal is prose that can be logged.
   */
  async host(options: HostOptions): Promise<HostedSession> {
    this.assertFree('host');
    const address = options.serverUrl.trim();
    const base = sessionBase(address);
    if (base === undefined) {
      throw new SessionRefused(
        'not-a-server',
        masked(address, `not a session address: ${address}`, '[address]'),
      );
    }
    const root = resolve(options.root);
    const walked = await enumerateGrant(root);
    this.listing.replace(walked.paths);
    let engine: SessionEngine;
    try {
      engine = await this.engines.host({
        baseUrl: base,
        displayName: options.displayName,
        listing: this.listing,
      });
    } catch (error: unknown) {
      throw new SessionRefused(
        'host-failed',
        masked(address, sentence(error), '[address]'),
      );
    }
    this.adopt(engine, 'host', root, walked.cut);
    const invite = engine.inviteUrl();
    if (invite === undefined) {
      await this.leave();
      throw new SessionRefused('no-invite', 'the room came up without an invite to hand on');
    }
    return {
      roomId: engine.session().roomId,
      role: engine.session().role,
      inviteUrl: invite,
      paths: walked.paths,
      cut: walked.cut,
      participants: this.participants(),
    };
  }

  /**
   * Joins the room an invite names. The engine reads the fragment and never puts it on the
   * socket; all this half does is not lose it — a refusal from the invite is reported with the
   * invite taken out of it, so that a diagnostic cannot carry the key.
   */
  async join(options: JoinOptions): Promise<JoinedSession> {
    this.assertFree('join');
    const invite = options.invite.trim();
    let engine: SessionEngine;
    try {
      engine = await this.engines.join({ invite, displayName: options.displayName });
    } catch (error: unknown) {
      throw new SessionRefused('join-failed', masked(invite, sentence(error)));
    }
    this.adopt(engine, 'guest', undefined, undefined);
    await this.settleGrant();
    const info = engine.session();
    const paths = this.grantedPaths();
    return {
      roomId: info.roomId,
      role: info.role,
      participants: this.participants(),
      paths,
      pathCount: paths.length,
    };
  }

  /** The live session's own state. A tool layer answering "where am I" asks this. */
  status(): SessionStatus {
    const engine = this.requireLive('reporting the session');
    const info = engine.session();
    return {
      mode: this.mode as Mode,
      live: this.live,
      roomId: info.roomId,
      role: info.role,
      participants: this.participants(),
      paths: this.grantedPaths(),
      cut: this.cut,
      documents: info.documents,
      problems: [...this.problems],
    };
  }

  /**
   * Leaves the session: a guest ends its connection, and a host closes the room for everyone —
   * the room is the host's folder, so it cannot outlive the folder's owner. Either way the
   * process is free for the next session.
   */
  async leave(): Promise<void> {
    const engine = this.requireLive('leaving');
    const mode = this.mode;
    this.engine = undefined;
    this.mode = undefined;
    this.root = undefined;
    this.cut = undefined;
    this.live = false;
    this.problems.length = 0;
    this.seeding.clear();
    this.writing.clear();
    try {
      if (mode === 'host') {
        await engine.closeRoom();
      }
    } finally {
      await engine.disconnect();
    }
  }

  /** The granted listing as this replica holds it: the host's walk, or the state's listing. */
  grantedPaths(): readonly string[] {
    return [...this.requireLive('reading the grant').grantedPaths()];
  }

  /**
   * Every seat in the room: this connection's own peer record and the peers the room reports,
   * each with whether it has published awareness.
   *
   * `presence()` is asked rather than a cursor rendered: this adapter reports that a peer is
   * here and publishing, and never invents a selection for it (`engine.md` §6).
   */
  participants(): readonly Participant[] {
    const engine = this.requireLive('listing the room');
    const aware = new Set<string>();
    for (const presence of engine.presence()) {
      const peer: PeerInfo | undefined = presence.peer;
      if (peer !== undefined && presence.state !== undefined) {
        aware.add(peer.peer_id);
      }
    }
    const info = engine.session();
    const rows: Participant[] = [];
    const seen = new Set<string>();
    for (const peer of [info.peer, ...info.peers]) {
      if (seen.has(peer.peer_id)) {
        continue;
      }
      seen.add(peer.peer_id);
      rows.push({
        peerId: peer.peer_id,
        displayName: peer.display_name,
        role: peer.role,
        aware: aware.has(peer.peer_id),
        self: peer.peer_id === info.peer.peer_id,
      });
    }
    return rows;
  }

  /**
   * The room's text for a granted path — the shared document, not a file on disk.
   *
   * The hold is taken and given up around the read: a hold is what asks the room for a document
   * (§13.7), and an agent browsing a folder should not leave every path it looked at held open in
   * everyone else's session. The text stays in this replica after the hold is released.
   */
  async read(path: string): Promise<SharedText> {
    const engine = this.requireLive('reading a granted path');
    this.assertShared(path);
    await engine.open(path);
    try {
      await this.awaitDocument(path);
      return { path, text: engine.text(path) };
    } finally {
      await engine.close(path);
    }
  }

  /** Replaces a granted file's whole text in the room. */
  async write(path: string, text: string): Promise<EditOutcome> {
    const wanted = toCrdt(text);
    if (overBound(wanted)) {
      throw new SessionRefused('too-large', `${path} is over the ${MAX_GRANT_FILE_BYTES} bytes a session carries`);
    }
    return await this.transform(path, () => wanted);
  }

  /**
   * Applies one range through `transform`, against the replica's own text as the hold finds it:
   * the ranges a caller sends are checked here, because the engine's index check is the last
   * thing that would fail and it fails as a `sessionError`, not as an answer.
   */
  async edit(path: string, change: TextChange): Promise<EditOutcome> {
    return await this.transform(path, (replica) => {
      assertChange(change, replica.length);
      return applyChange(replica, change);
    });
  }

  /**
   * Applies one local change through the engine's local-change path: `next` is handed the
   * replica's own text as this hold finds it and answers what the document should hold instead.
   * Only the difference between the two is published (§5), so a change cannot be computed against
   * one text and applied to another — a caller that has to read the text it replaces reads it
   * here, under the same hold, and not from a snapshot taken before. A `SessionRefused` thrown
   * from `next` is that caller's own refusal and publishes nothing.
   */
  async transform(path: string, next: (replica: string) => string): Promise<EditOutcome> {
    const engine = this.requireLive('editing a document');
    if (engine.session().role === 'viewer') {
      throw new SessionRefused(
        'read-only',
        `this seat holds ${path} in a room that seats it as a viewer, whose edits nobody else receives`,
      );
    }
    const refusal = publishRefusal(path);
    if (refusal !== undefined) {
      throw refusal;
    }
    await engine.open(path);
    let wanted: string;
    try {
      await this.awaitDocument(path);
      const replica = engine.text(path);
      wanted = next(replica);
      if (overBound(wanted)) {
        throw new SessionRefused('too-large', `${path} would be over the ${MAX_GRANT_FILE_BYTES} bytes a session carries`);
      }
      const delta = diff(replica, wanted);
      if (delta.end > delta.start) {
        engine.delete(path, delta.start, delta.end - delta.start);
      }
      if (delta.text !== '') {
        engine.insert(path, delta.start, delta.text);
      }
    } finally {
      await engine.close(path);
    }
    return { path, length: wanted.length, disk: await this.keepWorkingCopy(path, wanted) };
  }

  /** Renames this seat, which is the whole of the presence an agent publishes. */
  async rename(displayName: string): Promise<void> {
    await this.requireLive('renaming this seat').rename(displayName);
  }

  /** A host's invite, with the fragment. `undefined` for a guest, which was invited. */
  inviteUrl(): string | undefined {
    return this.requireLive('asking for the invite').inviteUrl();
  }

  // --- the private half -------------------------------------------------------

  /** The one-live-session rule the class states, in the shape a caller reads it. */
  private assertFree(what: 'host' | 'join'): void {
    const engine = this.engine;
    if (engine === undefined) {
      return;
    }
    const info = engine.session();
    throw new SessionRefused(
      'busy',
      `${what} was asked for while this process is already ${this.mode} of room ${info.roomId}: leave that session first`,
    );
  }

  private adopt(
    engine: SessionEngine,
    mode: Mode,
    root: string | undefined,
    cut: GrantCut | undefined,
  ): void {
    this.engine = engine;
    this.mode = mode;
    this.root = root;
    this.cut = cut;
    this.live = true;
    this.problems.length = 0;
    this.seeding.clear();
    this.writing.clear();
    engine.on((event) => {
      this.noteEvent(event);
    });
  }

  private requireLive(what: string): SessionEngine {
    const engine = this.engine;
    if (engine === undefined) {
      throw new SessionRefused(
        'no-session',
        `${what} needs a live session and there is none: host a folder or join an invite first`,
      );
    }
    return engine;
  }

  /**
   * What the room's own events say about this session. `live` follows the room rather than the
   * socket: this interface cannot see the transport, so a drop is taken from the events that
   * report one and the next event from the room is what says it is carrying again.
   */
  private noteEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'reconnecting':
      case 'disconnected':
      case 'roomGone':
        this.live = false;
        break;
      case 'documentChanged':
        this.live = true;
        void this.applyFromRoom(event.path);
        break;
      case 'documentsChanged':
        this.live = true;
        void this.seedRoom(event.documents);
        break;
      case 'grantChanged':
      case 'peersChanged':
      case 'presenceChanged':
      case 'hostAttached':
        this.live = true;
        break;
      case 'sessionError':
        this.note(
          undefined,
          'room-error',
          `the room refused something with no request to attach it to: ${event.code} ${event.message}`,
        );
        break;
      case 'hostDetached':
        break;
    }
  }

  /**
   * A host's working copy follows the room. A host whose disk silently diverged from the room
   * would be lying to whoever opens that folder next, and an agent has no unsaved-buffer concept
   * to hold the difference; a guest writes nothing, because the folder is not its own.
   *
   * The file is read, and written back, through the same clamp as any other read of the folder,
   * and the write resolves the path for itself rather than under the name the read answered with:
   * a symbolic link out of the folder, an ignored path and a path that is not a file at all are
   * refusals rather than writes, whether the link was there when the read ran or was swapped in
   * after it. A path the room has and the folder does not is *not* created — a create has to
   * resolve every directory on the way with the same hold, which is the write side of the clamp —
   * and that refusal is kept in `problems` rather than swallowed.
   *
   * The change waits for the write-back already in flight for the same path: two of them overlap
   * on a file each empties before it writes, which can leave one version's head under another's
   * tail, and the room's text is read here, when the wait is over, so the last change is the one
   * that lands.
   */
  private async applyFromRoom(path: string): Promise<void> {
    await this.serialized(path, async () => {
      const engine = this.engine;
      const root = this.root;
      if (engine === undefined || root === undefined) {
        return;
      }
      try {
        const current = await readGrantedFile(root, path);
        if (current.kind === 'refused') {
          this.note(path, current.cause, `the room changed ${path}, which this folder will not resolve`);
          return;
        }
        const text = engine.text(path);
        if (current.text === text) {
          return;
        }
        await writeWorkingCopy(root, path, text);
      } catch (error: unknown) {
        this.note(path, 'write-failed', `the room changed ${path} and writing it failed: ${sentence(error)}`);
      }
    });
  }

  /**
   * One write-back of a path at a time, which is what `applyFromRoom` and `keepWorkingCopy` are
   * made of. A change arrives while the one before it is still reading the folder or still
   * writing, and both would open the same leaf and empty it before writing to it — the file can
   * end up holding one version's head and another's tail, and an older text can be the one that
   * lands last, which leaves the host's folder diverged with no further event coming to fix it.
   *
   * A second ask joins the one in flight rather than starting beside it. The entry is dropped only
   * while it is still the one the map holds, so a chain that outlives a session neither answers
   * the next session's ask for the same path nor clobbers its entry.
   */
  private serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.writing.get(path) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled: Promise<void> = next.then(
      () => undefined,
      () => undefined,
    );
    this.writing.set(path, settled);
    void settled.then(() => {
      if (this.writing.get(path) === settled) {
        this.writing.delete(path);
      }
    });
    return next;
  }

  /** A host seeds the paths the room is holding and it has no document for (`§13.7`, §5). */
  private async seedRoom(documents: readonly string[]): Promise<void> {
    for (const path of documents) {
      try {
        await this.seedDocument(path);
      } catch (error: unknown) {
        this.note(path, causeOf(error), `the room holds ${path} and this host could not seed it: ${sentence(error)}`);
      }
    }
  }

  /**
   * Puts this folder's text for `path` into the room, which is what a hold on a path nothing has
   * arrived for is asking for. A guest does nothing here: it has no folder to answer from.
   *
   * One seed per path at a time. The room can ask for the same path twice while the first ask is
   * still reading the folder — the hold this process itself just took comes back as the room's
   * open set, and a `documentsChanged` and an `awaitDocument` for one path are two callers of
   * this. The `engine.has` check and the insertion below are a check-then-act across
   * `readGrantedFile`'s await, so without the map both callers would find no document and each
   * insert the whole file, doubling the room's text; a second ask joins the seed already in
   * flight instead. The insertion lands in the replica before the call returns, so a completed
   * seed needs no memory of its own — the next ask is answered by `engine.has`.
   */
  private async seedDocument(path: string): Promise<void> {
    const engine = this.requireLive('seeding a document');
    const root = this.root;
    if (root === undefined || engine.has(path)) {
      return;
    }
    const inFlight = this.seeding.get(path);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    const seed = this.readAndSeed(engine, root, path);
    this.seeding.set(path, seed);
    try {
      await seed;
    } finally {
      if (this.seeding.get(path) === seed) {
        this.seeding.delete(path);
      }
    }
  }

  /** The folder read and the one insertion a seed is, shared by every ask that joined it. */
  private async readAndSeed(engine: SessionEngine, root: string, path: string): Promise<void> {
    const read = await readGrantedFile(root, path);
    if (read.kind === 'refused') {
      throw new SessionRefused(read.cause, `${path} is in the room's open set and the grant will not read it`);
    }
    engine.insert(path, 0, toCrdt(read.text));
  }

  /**
   * Waits for the room's document for `path`, bounded. A host answers its own ask from its
   * folder first; a guest waits for the host to seed it, re-reading the predicate on the room's
   * events and on a poll, and gives up at its own deadline with what it saw.
   */
  private async awaitDocument(path: string): Promise<void> {
    const engine = this.requireLive('waiting for a document');
    if (this.mode === 'host') {
      await this.seedDocument(path);
    }
    if (engine.has(path)) {
      return;
    }
    const arrived = await this.until(() => this.engine?.has(path) === true, this.documentWaitMs);
    if (!arrived) {
      const open = engine.session().documents;
      throw new SessionRefused(
        'timed-out',
        `no text for ${path} arrived within ${this.documentWaitMs} ms: the room's open set is ${open.length === 0 ? 'empty' : open.join(', ')}`,
      );
    }
  }

  /**
   * The host's own write-back, through the same clamp as an incoming change, and through the same
   * one-at-a-time rule: an incoming change for the path can be waiting in the chain when the edit
   * returns, and the folder follows the room, so what is written is the replica's text as this
   * turn finds it rather than the text the edit handed over.
   */
  private async keepWorkingCopy(path: string, text: string): Promise<EditOutcome['disk']> {
    const root = this.root;
    if (root === undefined) {
      return 'none';
    }
    return this.serialized(path, async () => {
      const engine = this.engine;
      const wanted = engine !== undefined && engine.has(path) ? engine.text(path) : text;
      try {
        const current = await readGrantedFile(root, path);
        if (current.kind === 'refused') {
          this.note(path, current.cause, `${path} holds the edit in the room and this folder would not resolve it`);
          return 'refused';
        }
        if (current.text === wanted) {
          return 'unchanged';
        }
        await writeWorkingCopy(root, path, wanted);
        return 'written';
      } catch (error: unknown) {
        this.note(path, 'write-failed', `${path} holds the edit in the room and writing it failed: ${sentence(error)}`);
        return 'refused';
      }
    });
  }

  /**
   * A path the room shares: the grant's own name rules, and the room's listing as this replica
   * holds it. The listing is why a read is asked of this and an edit is not: the text of a path
   * no seat is sharing is not in any replica to read, while an edit of a path outside the listing
   * is a document the room carries and nobody has published (`seedRefusal`'s gate is the name
   * rules and the size, not the listing).
   */
  private assertShared(path: string): void {
    if (!isGrantedPath(path)) {
      throw new SessionRefused('not-granted', `${JSON.stringify(path)} is not a path the grant names`);
    }
    if (!this.grantedPaths().includes(path)) {
      throw new SessionRefused(
        'not-granted',
        `${path} is not in the room's listing, so there is no shared text for it here`,
      );
    }
  }

  /**
   * Waits for a predicate to hold, bounded: the engine's own events are what usually make it
   * true, a poll bounds how long a missed event could go unnoticed, and the deadline ends the
   * wait. The deadline re-reads the predicate, so a wait that lands on the answer is not lost.
   */
  private async until(holds: () => boolean, ms: number): Promise<boolean> {
    if (holds()) {
      return true;
    }
    const engine = this.requireLive('waiting');
    return await new Promise<boolean>((settle) => {
      let finished = false;
      const finish = (value: boolean): void => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(deadline);
        clearInterval(poll);
        off();
        settle(value);
      };
      const off = engine.on(() => {
        if (holds()) {
          finish(true);
        }
      });
      const poll = setInterval(() => {
        if (holds()) {
          finish(true);
        }
      }, POLL_MS);
      const deadline = setTimeout(() => {
        finish(holds());
      }, ms);
    });
  }

  /**
   * Waits, briefly, for a listing a join has not been told yet: §7.1's state carries it, and a
   * seat that opened with no documents waits for it the way the companion does (`engine.md` §4).
   *
   * The wait ending either way is why joining an empty room answers with an empty listing rather
   * than a refusal, and it is also why the wait's own answer is not thrown away: through this
   * interface an empty folder and a listing still on its way are the same absent number, so a
   * listing that never arrived is recorded with the wait that expired. `status` then says which
   * of the two this was instead of reporting both as an empty room.
   */
  private async settleGrant(): Promise<void> {
    const engine = this.requireLive('settling the grant');
    const info = engine.session();
    if (info.role === 'host' || info.documents.length > 0 || engine.grantedPaths().length > 0) {
      return;
    }
    const arrived = await this.until(
      () => (this.engine?.grantedPaths().length ?? 0) > 0,
      this.grantWaitMs,
    );
    if (!arrived) {
      this.note(
        undefined,
        'timed-out',
        `no listing arrived within ${this.grantWaitMs} ms, which an empty folder and one still on its way both look like here: this replica holds ${engine.grantedPaths().length} granted path(s)`,
      );
    }
  }

  /** Keeps a refusal nobody asked for, so that `status` can report a host that has fallen behind. */
  private note(path: string | undefined, cause: SessionRefusal, message: string): void {
    this.problems.push({ path, cause, message });
    while (this.problems.length > this.problemLimit) {
      this.problems.shift();
    }
  }
}

/** How often a bounded wait re-reads its predicate between the events that wake it. */
const POLL_MS = 20;

/**
 * What to do with a path this session is asked to publish into the room: the grant's own name
 * rules and the size a session carries, which is the same gate the bridge puts on publishing an
 * edit (`seedRefusal`). The room's listing is deliberately not asked here — a host's file created
 * after its last walk is shareable and simply not listed yet.
 */
function publishRefusal(path: string): SessionRefused | undefined {
  if (!isGrantedPath(path)) {
    return new SessionRefused('not-granted', `${JSON.stringify(path)} is not a path the grant names`);
  }
  return undefined;
}

/** A caller's change, checked against the text it says it changes. Absent checks fail as indices. */
function assertChange(change: TextChange, length: number): void {
  const fits =
    Number.isInteger(change.start) &&
    Number.isInteger(change.end) &&
    change.start >= 0 &&
    change.end >= change.start &&
    change.end <= length;
  if (!fits) {
    throw new SessionRefused(
      'bad-change',
      `a change of [${change.start}, ${change.end}) does not fit the ${length} code units the replica holds`,
    );
  }
}

/** Over the bytes a session will carry, by the same bound a listing walk applies to a file. */
function overBound(text: string): boolean {
  return text.length > MAX_GRANT_FILE_BYTES || Buffer.byteLength(text, 'utf8') > MAX_GRANT_FILE_BYTES;
}

/**
 * Writes the room's text into the folder a host shares, through the same clamp a read of it goes
 * through: `writeGrantedFile` resolves every segment inside the descriptor of the directory before
 * it and opens the leaf `O_NOFOLLOW` through that descriptor, so a name swapped for a symbolic
 * link is refused where it is opened rather than followed. The read that decides *whether* the
 * write is needed is a separate resolution of the same path and is never what authorises the
 * write. What is left over is what `readGrantedFile` leaves: a segment that is a mount point, and
 * a platform without `/proc/self/fd`, where the steps are checked by name.
 */
async function writeWorkingCopy(root: string, path: string, text: string): Promise<void> {
  if (overBound(text)) {
    throw new SessionRefused('too-large', `${path} is over the ${MAX_GRANT_FILE_BYTES} bytes a session carries`);
  }
  const written = await writeGrantedFile(root, path, text);
  if (written.kind === 'refused') {
    throw new SessionRefused(
      written.cause,
      `${JSON.stringify(path)} is not a file this folder will write`,
    );
  }
}

/**
 * The code a problem is recorded under. A refusal made here carries its own — most of them are the
 * grant's ruling on the path — and anything else has no code of its own to keep, so it is recorded
 * as nothing having been there, which is what a read that failed for a reason of its own amounts to.
 */
function causeOf(error: unknown): SessionRefusal {
  return error instanceof SessionRefused ? error.code : 'missing';
}

/** An error's own sentence, for a problem nobody asked for. */
function sentence(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
/**
 * `text` read back without `secret` in it, when there is one to take out. An invite's fragment is
 * a room key, and a refusal that quotes the link is a refusal that can be logged, shown or written
 * to a file with the key in it; an address a caller hands to `host` is taken out for the same
 * reason, because an invite handed where an address belongs is such a link.
 *
 * `secret` is the one string this server knows could be a credential, and it is the caller's own:
 * an engine that fails after minting a link of its own is not reached, because a host that fails
 * never has an invite in this process's hands. An empty secret is nothing to take out, and
 * splitting on it would put the placeholder between every two characters of the message instead.
 */
function masked(secret: string, text: string, placeholder = '[invite]'): string {
  return secret === '' ? text : text.split(secret).join(placeholder);
}
