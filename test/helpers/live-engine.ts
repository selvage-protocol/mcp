/**
 * A live session for a child process, without a relay server.
 *
 * `src/main.ts` opens the real engine over a real socket, and a test that wants a *live* session
 * in that process has no server to give it one; this module is loaded ahead of the entry point
 * (`node --import <this file> src/main.ts`) and replaces `PeerEngine.host` with a stub, so the
 * tool surface, the session and the shutdown path are all the shipped ones and only the room is
 * the test's.
 *
 * What the stub keeps is the part of an engine that holds the event loop open: a timer, standing
 * in for the transport's socket, which the vendored engine does not `unref` and which only
 * leaving the session clears. A process that does not leave its session therefore outlives its
 * client, which is what the test asserts about.
 *
 * Nothing here decides anything: `StubEngine` is the same stub the adapter's own tests drive, and
 * the compile-time check that it satisfies `SessionEngine` holds it to the real interface.
 */

const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

// The engine's own dependency asks whether a browser is there as it is evaluated, and `main.ts`
// answers it for the same reason it does: the answer is what keeps the warning off stderr. The
// imports are here rather than at the top because evaluating them is what reads the global.
Object.defineProperty(globalThis, 'localStorage', {
  value: undefined,
  configurable: true,
  writable: true,
});

const { PeerEngine } = await import('../../vendor/bridge/index.ts');
const { StubEngine } = await import('./stub-engine.ts');

// A room that never lets go, for the bound `main.ts` puts on leaving: the connection stays open
// and the leave never answers, so the deadline is the only thing that can end the process.
const stuck = process.env['SELVAGE_TEST_ENGINE_STUCK'] === '1';

// A path the room announces a change to, once the session is hosted, so a test can watch a
// notification cross the real stdio framing. Two changes, spaced past the per-path window: the
// first is the document arriving, the second a hunk against it.
const announce = process.env['SELVAGE_TEST_ENGINE_ANNOUNCE'];

const engine = new StubEngine({ role: 'host', invite: INVITE, listing: [] });
const held = setInterval(() => undefined, 1_000);
let announcing: NodeJS.Timeout[] = [];
const disconnect = engine.disconnect.bind(engine);
engine.disconnect = async (): Promise<void> => {
  for (const timer of announcing) {
    clearTimeout(timer);
  }
  announcing = [];
  if (stuck) {
    await new Promise<void>(() => undefined);
    return;
  }
  clearInterval(held);
  await disconnect();
};

PeerEngine.host = (async () => {
  if (announce !== undefined && announce !== '') {
    announcing = [
      setTimeout(() => {
        engine.remote(announce, 'first\n');
        engine.emit({ type: 'documentChanged', path: announce });
      }, 50),
      setTimeout(() => {
        engine.remote(announce, 'first\nsecond\n');
        engine.emit({ type: 'documentChanged', path: announce });
      }, 700),
    ];
  }
  return engine;
}) as unknown as typeof PeerEngine.host;
