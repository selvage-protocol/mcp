/**
 * The two forms `session_host` answers with, proven against a real server: a peer joins with the
 * page link a person would open, and a peer joins with the client invite, and both land in the
 * host's room. This is the defect the page link exists for — a person handed the client form —
 * so the proof is a real `selvaged` and a real join, never a parse alone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { STEP_MS, Tool } from '../helpers/mcp-tool.ts';
import { scratch } from '../helpers/scratch.ts';
import { RealSelvaged } from '../helpers/selvaged.ts';
import { until } from '../helpers/until.ts';

function roomOf(hosted: string): string {
  const match = /^hosting room (\S+) as (\S+),/.exec(hosted);
  assert.ok(match !== null, `session_host answered something else: ${hosted}`);
  return match[1] as string;
}

function linkOf(hosted: string, name: 'page' | 'invite'): string {
  const match = new RegExp(`^${name}: (\\S+)`, 'm').exec(hosted);
  assert.ok(match !== null, `session_host answered no ${name} link: ${hosted}`);
  return match[1] as string;
}

test('a peer joins with the page link and a peer with the client invite, both in one room', { timeout: STEP_MS * 2 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-forms-host');
  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const byPage = await Tool.start(t, 'page', {
    cwd: await scratch('e2e-forms-page'),
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });
  const byInvite = await Tool.start(t, 'invite', {
    cwd: await scratch('e2e-forms-invite'),
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'heidi' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const room = roomOf(hosted);
  const page = linkOf(hosted, 'page');
  const invite = linkOf(hosted, 'invite');

  // The two links are one invitation: the same room, token and key fragment, over the page's
  // scheme and the socket's.
  const pageUrl = new URL(page);
  const inviteUrl = new URL(invite);
  assert.equal(pageUrl.protocol, 'http:');
  assert.equal(inviteUrl.protocol, 'ws:');
  assert.equal(pageUrl.searchParams.get('room'), inviteUrl.searchParams.get('room'));
  assert.equal(pageUrl.searchParams.get('token'), inviteUrl.searchParams.get('token'));
  assert.equal(pageUrl.hash, inviteUrl.hash);
  assert.ok(pageUrl.hash.includes('#k='), `the page link carries no room key: ${page}`);
  assert.ok(pageUrl.hash.includes('&h='), `the page link carries no host key: ${page}`);

  // The person's link seats a peer.
  const pageJoined = await byPage.call('session_join', { invite: page });
  assert.match(pageJoined, /^joined room \S+ as guest,/, `the page link did not seat a peer: ${pageJoined}`);
  assert.ok(pageJoined.includes(room), `the page link joined another room: ${pageJoined}`);

  // The client link seats a peer in the same room.
  const inviteJoined = await byInvite.call('session_join', { invite });
  assert.match(inviteJoined, /^joined room \S+ as guest,/, `the invite did not seat a peer: ${inviteJoined}`);
  assert.ok(inviteJoined.includes(room), `the invite joined another room: ${inviteJoined}`);

  // The room holds all three seats: the host, the page joiner and the invite joiner.
  await until(
    'the host to see both joiners',
    () => host.raw('session_status'),
    (text) => /^participants: 3$/m.test(text),
    STEP_MS,
  );
});
