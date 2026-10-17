/**
 * The rewrite `session_host` relies on: a client invite read back as the page link a person opens.
 *
 * The page link's shape is the thing a real session got wrong — a person was handed the client
 * form and the browser refused it — so every case here is read through the browser client's own
 * decision (`test/helpers/page-link.ts`), never by string prefix alone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeKey } from '../vendor/engine/index.ts';
import { pageLink } from '../src/invite.ts';
import { clientAcceptsPageLink } from './helpers/page-link.ts';

const KEYS = `#k=${encodeKey(new Uint8Array(32).fill(1))}&h=${encodeKey(new Uint8Array(32).fill(2))}`;

function wire(host: string, room = 'room-1', token = 'tok-1'): string {
  return `wss://${host}/session?room=${room}&token=${token}${KEYS}`;
}

test('a client invite reads back as the page link that opens the same room', () => {
  const source = wire('room.example');
  const page = pageLink(source);
  assert.equal(page, `https://room.example/?room=room-1&token=tok-1${KEYS}`);
  const read = clientAcceptsPageLink(page);
  assert.ok(read !== undefined, `the browser client would refuse ${page}`);
  assert.equal(read.room, 'room-1');
  assert.equal(read.token, 'tok-1');
  assert.equal(read.invite.roomKey.length, 32);
  assert.equal(read.invite.hostKey.length, 32);
  // The page's root, not the endpoint: a request for the endpoint is a file the page server does
  // not hold (`reference_server/crates/selvaged/src/page.rs`), so this is the half that broke.
  assert.equal(new URL(page).pathname, '/');
  assert.ok(!new URL(page).pathname.endsWith('/session'));
});

test('a base with a path prefix keeps it, and the page root stays under it', () => {
  const page = pageLink(wire('room.example/under'));
  assert.equal(page, `https://room.example/under/?room=room-1&token=tok-1${KEYS}`);
  assert.ok(clientAcceptsPageLink(page) !== undefined, page);
  assert.ok(!new URL(page).pathname.endsWith('/session'));
});

test('plaintext stays plaintext: a ws:// invite reads back as an http:// page', () => {
  const page = pageLink(wire('room.example').replace('wss://', 'ws://'));
  assert.match(page, /^http:\/\/room\.example\/\?/);
  assert.ok(clientAcceptsPageLink(page) !== undefined, page);
});

test('the query keeps a value’s own encoding, and the fragment travels whole', () => {
  const room = 'room%2B1%2F2'; // `+` and `/`, percent-encoded as §5.1 writes them.
  const page = pageLink(wire('room.example', room));
  assert.ok(page.includes(`room=${room}`), page);
  assert.ok(page.endsWith(KEYS), page);
  const read = clientAcceptsPageLink(page);
  assert.ok(read !== undefined, page);
  assert.equal(read.room, 'room+1/2');
  assert.equal(read.invite.roomKey.length, 32);
});

test('a page link and a link that names no session are handed back unchanged', () => {
  const page = pageLink(wire('room.example'));
  assert.equal(pageLink(page), page);
  assert.equal(pageLink('not a url'), 'not a url');
  assert.equal(pageLink('https://room.example/'), 'https://room.example/');
  assert.equal(pageLink('wss://room.example/session'), 'wss://room.example/session');
});

test('a link with no fragment is still a client invite but no page a client would join', () => {
  const fragmentless = `wss://room.example/session?room=room-1&token=tok-1`;
  const page = pageLink(fragmentless);
  assert.equal(page, 'https://room.example/?room=room-1&token=tok-1');
  // The rewrite keeps what it was given: with no fragment there is no key, so the client refuses
  // it — which is the refusal a truncated link should get, and the rewrite never invents a key.
  assert.equal(clientAcceptsPageLink(page), undefined);
});
