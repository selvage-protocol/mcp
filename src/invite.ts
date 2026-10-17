/**
 * The two forms one invite takes, and the rewrite between them.
 *
 * §5.1's invite is a URL either way, and the same room, token and fragment travel on it. What
 * differs is who can open it. A browser fetches a *page* on the server's `http(s)` origin, whose
 * root serves the client and whose query names the room and token; a client dials the `ws(s)`
 * `/session` endpoint the engine speaks. The engine mints the client form, and the web client's
 * own share bar builds the page form (`buildShareLink` in `web_client/src/browser/share.ts`), so
 * this is the reverse rewrite — the link `session_host` hands a person — and it is the inverse of
 * the engine's own page-to-wire rewrite (`wireInvite` in `vendor/engine/relay.ts`).
 */

import { sessionBase } from '../vendor/engine/index.ts';

/** The engine's endpoint path: the one segment a page link must not carry. */
const ENDPOINT_PATH = '/session';

/** The browser scheme each socket scheme's page is served over. */
const PAGE_SCHEME: ReadonlyMap<string, string> = new Map([
  ['ws:', 'http:'],
  ['wss:', 'https:'],
]);

/**
 * Reads a client invite back as the page link it names, or hands it back unchanged when it is not
 * one. The fragment is carried across verbatim: it is the key, and a link that dropped it would
 * open a room nobody could join.
 *
 * The page's query is carried across verbatim too, so a value's own encoding survives. The path is
 * the base the invite names — the endpoint segment dropped, a trailing slash dropped, and the one
 * `/` the page's root is spelled with put back — which is the spelling the engine's own reader
 * resolves to the same base.
 */
export function pageLink(wireInvite: string): string {
  const hash = wireInvite.indexOf('#');
  const address = hash === -1 ? wireInvite : wireInvite.slice(0, hash);
  const fragment = hash === -1 ? '' : wireInvite.slice(hash);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return wireInvite;
  }
  const scheme = PAGE_SCHEME.get(url.protocol);
  if (scheme === undefined) {
    return wireInvite;
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path.endsWith(ENDPOINT_PATH)) {
    return wireInvite;
  }
  const room = url.searchParams.get('room');
  const token = url.searchParams.get('token');
  if (room === null || room === '' || token === null || token === '') {
    return wireInvite;
  }
  const prefix = path.slice(0, path.length - ENDPOINT_PATH.length).replace(/\/+$/, '');
  // The base is read back through the engine, so the page origin this writes is one the engine
  // reads either way: a link that names something else is handed back unchanged.
  if (sessionBase(`${scheme}//${url.host}${prefix}`) === undefined) {
    return wireInvite;
  }
  return `${scheme}//${url.host}${prefix}/?${url.search.replace(/^\?/, '')}${fragment}`;
}
