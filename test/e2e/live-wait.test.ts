/**
 * The end-to-end proof for the live loop: two MCP servers over their real stdio, one room on a
 * real `selvaged`, and the wait returning on the other seat's edit rather than at its deadline.
 *
 * Nothing is stubbed. The host shares a folder, the guest joins the invite, the host blocks in
 * `wait_for_change`, and the guest edits the shared file. The assertion is the hunk the wait
 * handed back — its `-` and `+` lines and the file's new length — and the fact that it arrived
 * long before the deadline it was given. A later, short wait proves the host's own edit is not
 * reported back to it.
 *
 * The second proof is the one an agent works by: a seat that holds a wait and still answers a
 * question while it is held, without the room change it is waiting for being lost.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { STEP_MS, Tool } from '../helpers/mcp-tool.ts';
import { put, scratch } from '../helpers/scratch.ts';
import { RealSelvaged } from '../helpers/selvaged.ts';
import { until } from '../helpers/until.ts';

/** The wait's own deadline; the edit must beat it by a wide margin for this to be a proof. */
const WAIT_MS = 20_000;

function roomIdOf(hosted: string): string {
  const match = /^hosting room (\S+) as (\S+),/.exec(hosted);
  assert.ok(match !== null, `session_host answered something else: ${hosted}`);
  return match[1] as string;
}

function inviteOf(hosted: string): string {
  const match = /^invite: (\S+)/m.exec(hosted);
  assert.ok(match !== null, `session_host answered no invite URL: ${hosted}`);
  return match[1] as string;
}

test('one seat waits and another edits: the wait returns the hunk, not its deadline', { timeout: WAIT_MS * 3 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-live-host');
  const guestFolder = await scratch('e2e-live-guest');
  const before = 'ada types here\n';
  await put(hostFolder, 'a.txt', before);

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const room = roomIdOf(hosted);
  const joined = await guest.call('session_join', { invite: inviteOf(hosted) });
  assert.ok(joined.includes(room), `the guest joined another room: ${joined}`);
  await until(
    'the host to see the guest',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // The host blocks first; the guest's edit is what must wake it. The wait's own deadline is
  // long, so a return with a hunk is proof the room moved it and the clock did not. It watches
  // `a.txt` alone, so the roster change the join left pending is not what it reports.
  const started = Date.now();
  const waiting = host.raw('wait_for_change', { paths: ['a.txt'], timeout_ms: WAIT_MS }, WAIT_MS * 2);
  // A beat, so the wait is registered and blocking before the edit lands.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await guest.call('edit_file', { path: 'a.txt', old_string: 'ada', new_string: 'grace' });
  const report = await waiting;
  const elapsed = Date.now() - started;

  assert.ok(!report.startsWith('no change within'), `the wait timed out instead of returning a change: ${report}`);
  assert.match(report, /^a\.txt: changed \(\d+ characters now\)$/m, report);
  assert.match(report, /^- +1 ada types here$/m, report);
  assert.match(report, /^\+ +1 grace types here$/m, report);
  assert.ok(
    elapsed < WAIT_MS / 2,
    `the wait returned at ${elapsed} ms, which is too close to its ${WAIT_MS} ms deadline to prove it was woken`,
  );

  // The host's own folder follows the room, which is the other half of a host's job.
  const onDisk = await until(
    "the host's own folder to follow the room",
    () => readFile(join(hostFolder, 'a.txt'), 'utf8'),
    (text) => text === 'grace types here\n',
    STEP_MS,
  );
  assert.equal(onDisk, 'grace types here\n');

  // The host's own edit is not a room change to report back: a short wait afterwards times out
  // rather than handing the seat its own work.
  await host.call('edit_file', { path: 'a.txt', old_string: 'grace', new_string: 'ada' });
  const quiet = await host.raw('wait_for_change', { paths: ['a.txt'], timeout_ms: 400 }, 5_000);
  assert.match(quiet, /^no change within 400 ms/, quiet);
});

test('a seat that holds a wait still answers, and the change it waits for still lands', { timeout: WAIT_MS * 3 }, async (t) => {
  // The live loop an agent actually works in: a wait held in the background while the same seat
  // asks where it stands and what it can read. Before the transport answered each message on its
  // own, the held wait starved every other call on that seat until its deadline.
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-beside-host');
  const guestFolder = await scratch('e2e-beside-guest');
  await put(hostFolder, 'a.txt', 'ada types here\n');

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'ada' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'grace' },
  });

  const hosted = await host.call('session_host', { folder: hostFolder });
  const joined = await guest.call('session_join', { invite: inviteOf(hosted) });
  assert.ok(joined.includes(roomIdOf(hosted)), `the guest joined another room: ${joined}`);
  await until(
    'the host to see the guest',
    () => host.raw('session_status'),
    (text) => /^participants: 2$/m.test(text),
    STEP_MS,
  );

  // Held, and not awaited: the background wait the defect was reported from. Its answer is read
  // after the questions below, which is the order the seat asks them in.
  const waitId = host.send('wait_for_change', { paths: ['a.txt'], timeout_ms: WAIT_MS });

  // Both questions are answered while the wait is still blocking, which is the whole point.
  const status = await host.call('session_status', {}, 5_000);
  assert.match(status, /^participants: 2$/m, status);
  assert.equal(await host.call('list_paths', { prefix: 'a.txt' }, 5_000), 'a.txt');

  // The other seat's edit is what the held wait is for, and it still lands: answering beside the
  // wait neither extended it nor took the change away from it.
  const started = Date.now();
  await guest.call('edit_file', { path: 'a.txt', old_string: 'ada', new_string: 'grace' });
  const report = await host.answered(waitId, 'wait_for_change', WAIT_MS * 2);
  const elapsed = Date.now() - started;

  assert.ok(!report.startsWith('no change within'), `the wait timed out instead of returning a change: ${report}`);
  assert.match(report, /^a\.txt: changed \(\d+ characters now\)$/m, report);
  assert.match(report, /^- +1 ada types here$/m, report);
  assert.match(report, /^\+ +1 grace types here$/m, report);
  assert.ok(
    elapsed < WAIT_MS / 2,
    `the wait returned at ${elapsed} ms, which is too close to its ${WAIT_MS} ms deadline to prove it was woken`,
  );
});
