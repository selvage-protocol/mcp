/**
 * A session engine that is only what these tests decide it is: a room's facts in fields, every
 * call the adapter makes in `calls`, and events the test fires by hand.
 *
 * It is not a second implementation of the engine — nothing here decides anything, and the one
 * thing it must get right is the shape: `SessionEngine` is checked against it at compile time, so
 * a member the adapter calls and this class does not have is a type error rather than a test that
 * silently never runs.
 */

import { sessionBase } from '../../vendor/engine/index.ts';
import type {
  AwarenessState,
  EngineEvent,
  EngineEventListener,
  OffsetSelection,
  PeerInfo,
  Presence,
  Role,
  Selection,
  SessionBase,
  SessionInfo,
} from '../../vendor/engine/index.ts';
import type {
  EngineFactory,
  HostEngineOptions,
  JoinEngineOptions,
  SessionEngine,
} from '../../src/session.ts';

const BASE = sessionBase('ws://stub.invalid');
if (BASE === undefined) {
  throw new Error('the stub names a base the engine refuses, which cannot happen');
}

/** One peer record, as the room would spell it. */
export function peer(
  peerId: string,
  displayName: string,
  role: Role,
  awarenessClientId?: number,
): PeerInfo {
  return {
    peer_id: peerId,
    display_name: displayName,
    role,
    ...(awarenessClientId === undefined ? {} : { awareness_client_id: awarenessClientId }),
  };
}

export interface StubOptions {
  readonly roomId?: string;
  readonly role?: Role;
  readonly invite?: string | undefined;
  readonly listing?: readonly string[];
  readonly documents?: readonly string[];
  readonly texts?: ReadonlyMap<string, string>;
  readonly self?: PeerInfo;
  readonly peers?: readonly PeerInfo[];
  readonly presence?: readonly Presence[];
  /** Called by `open`, which is where a test lets the room's text arrive — or does not. */
  readonly onOpen?: (path: string, engine: StubEngine) => void;
}

export class StubEngine implements SessionEngine {
  /** Every call the adapter made, in order, as text a test can assert on. */
  readonly calls: string[] = [];
  readonly roomId: string;
  role: Role;
  invite: string | undefined;
  listing: readonly string[];
  documents: readonly string[];
  readonly texts: Map<string, string>;
  readonly self: PeerInfo;
  peers: readonly PeerInfo[];
  presenceList: readonly Presence[];
  connected = true;

  private readonly listeners = new Set<EngineEventListener>();
  private readonly onOpen: ((path: string, engine: StubEngine) => void) | undefined;

  constructor(options: StubOptions = {}) {
    this.roomId = options.roomId ?? 'room-1';
    this.role = options.role ?? 'guest';
    this.invite = options.invite;
    this.listing = [...(options.listing ?? [])];
    this.documents = [...(options.documents ?? [])];
    this.texts = new Map(options.texts ?? []);
    this.self = options.self ?? peer('self', 'agent', options.role ?? 'guest');
    this.peers = [...(options.peers ?? [])];
    this.presenceList = [...(options.presence ?? [])];
    this.onOpen = options.onOpen;
  }

  session(): SessionInfo {
    return {
      roomId: this.roomId,
      role: this.role,
      peer: this.self,
      peers: [...this.peers],
      documents: [...this.documents],
      capabilities: [],
      keepalive: { ping_interval_ms: 15_000, awareness_renew_ms: 5_000, awareness_expire_ms: 15_000 },
      baseUrl: BASE as SessionBase,
    };
  }

  text(path: string): string {
    return this.texts.get(path) ?? '';
  }

  has(path: string): boolean {
    return this.texts.has(path);
  }

  async open(path: string): Promise<void> {
    this.calls.push(`open ${path}`);
    this.onOpen?.(path, this);
  }

  async close(path: string): Promise<void> {
    this.calls.push(`close ${path}`);
  }

  insert(path: string, index: number, text: string): void {
    this.calls.push(`insert ${path} ${index} ${JSON.stringify(text)}`);
    const current = this.text(path);
    this.texts.set(path, current.slice(0, index) + text + current.slice(index));
  }

  delete(path: string, index: number, length: number): void {
    this.calls.push(`delete ${path} ${index} ${length}`);
    const current = this.text(path);
    this.texts.set(path, current.slice(0, index) + current.slice(index + length));
  }

  setSelection(path: string, selection: OffsetSelection): void {
    this.calls.push(`setSelection ${path} ${selection.anchor}..${selection.head}`);
  }

  setAwareness(state: AwarenessState | null): void {
    this.calls.push(`setAwareness ${state === null ? 'null' : JSON.stringify(state)}`);
  }

  presence(): Presence[] {
    return [...this.presenceList];
  }

  resolveSelection(_path: string, _selection: Selection): OffsetSelection | undefined {
    return undefined;
  }

  on(listener: EngineEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  inviteUrl(): string | undefined {
    return this.invite;
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect');
    this.connected = false;
    this.listeners.clear();
  }

  async closeRoom(): Promise<boolean> {
    this.calls.push('closeRoom');
    return this.role === 'host';
  }

  async rename(displayName: string): Promise<void> {
    this.calls.push(`rename ${displayName}`);
    this.self.display_name = displayName;
  }

  async grant(paths: readonly string[]): Promise<void> {
    this.calls.push(`grant ${paths.join(',')}`);
    this.listing = [...paths];
  }

  grantedPaths(): string[] {
    return [...this.listing];
  }

  /** Fires one event at the adapter, which is how a test moves the room. */
  emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  /** Puts text in the room, as a peer's edit would, without saying anything about it. */
  remote(path: string, text: string): void {
    this.texts.set(path, text);
  }
}

/** An engine factory that hands back a stub a test prepared, and records what it was asked. */
export class StubFactory implements EngineFactory {
  readonly hosted: HostEngineOptions[] = [];
  readonly joined: JoinEngineOptions[] = [];
  /** What `host` answers with, or throws; a test sets one of them before the session opens. */
  hostResult: StubEngine | undefined;
  hostError: unknown;
  /** The same for `join`. */
  joinResult: StubEngine | undefined;
  joinError: unknown;

  constructor(engine?: StubEngine) {
    this.hostResult = engine;
    this.joinResult = engine;
  }

  async host(options: HostEngineOptions): Promise<StubEngine> {
    this.hosted.push(options);
    if (this.hostError !== undefined) {
      throw this.hostError;
    }
    return this.hostResult ?? new StubEngine({ role: 'host' });
  }

  async join(options: JoinEngineOptions): Promise<StubEngine> {
    this.joined.push(options);
    if (this.joinError !== undefined) {
      throw this.joinError;
    }
    return this.joinResult ?? new StubEngine();
  }
}
