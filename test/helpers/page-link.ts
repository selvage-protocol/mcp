/**
 * The browser client's own decision, read from the engine it shares.
 *
 * A page link is accepted by the web client in two steps (`web_client/src/browser/share.ts` and
 * `join.ts`): `parsePageLink` reads the query with the engine's `inviteQuery` and the fragment off
 * the URL, and `inviteShortfall` rebuilds the wire URL and hands it to the engine's `parseInvite`.
 * This is that decision, and it is a second implementation only because the client is another
 * repository this checkout cannot import: every rule it applies is the engine's, so what it
 * accepts is what the client accepts.
 */

import { inviteQuery, parseInvite, sessionBase, sessionUrl } from '../../vendor/engine/index.ts';
import type { PeerInvite } from '../../vendor/engine/index.ts';

export interface AcceptedPageLink {
  readonly room: string;
  readonly token: string;
  readonly invite: PeerInvite;
}

/** The room a page link names, or `undefined` when the browser client would refuse the link. */
export function clientAcceptsPageLink(text: string): AcceptedPageLink | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined;
  }
  // The client's own query text: a literal `?` past the first is a separator, as a page's is.
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const join = inviteQuery(query.replace(/\?/g, '&'));
  if (!join.ok || join.room === '' || join.token === '') {
    return undefined;
  }
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = sessionBase(`${scheme}//${url.host}${url.pathname.replace(/\/+$/, '')}`);
  if (base === undefined) {
    return undefined;
  }
  const read = parseInvite(`${sessionUrl(base, join.room, join.token)}${url.hash}`);
  if (!read.ok) {
    return undefined;
  }
  return { room: join.room, token: join.token, invite: read.invite };
}
