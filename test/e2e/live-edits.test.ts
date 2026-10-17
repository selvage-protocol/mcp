/**
 * The end-to-end proof for the shape a live session doubled a document in: a host shares a
 * folder, a person joins and types a line, and the host then waits, reads and makes several
 * `edit_file` calls in a row.
 *
 * Nothing is stubbed: two MCP servers over their own stdio and one room on a real `selvaged`.
 * Every assertion is the whole text as the room holds it and as the host's folder holds it, and
 * the number of times each part appears — a room holding a document twice answers with it twice,
 * and so does the folder that follows it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { STEP_MS, Tool } from '../helpers/mcp-tool.ts';
import { put, scratch } from '../helpers/scratch.ts';
import { RealSelvaged } from '../helpers/selvaged.ts';
import { until } from '../helpers/until.ts';

/** The document the live session's folder held, before the host's own edits. */
const BEFORE = [
  '# Notes',
  '',
  'Host: pi',
  'Guest: user (joined live, cursor publishing)',
  '',
  '## What we are doing',
  '',
  'Two seats, one document, live.',
  '',
  '## Scratch',
  '',
  '- [ ] when you join, add a line here and I will see it arrive',
  '',
  '## Try this',
  '',
  '- [ ] replace this line with anything and watch the wait fire',
  '',
].join('\n');

/** The line the person typed, and the reply the host writes back under it. */
const PERSON = 'hello, how are you :3';
const REPLY = 'Doing well. Your line reached me as a diff hunk on line 13, …';

function roomIdOf(hosted: string): string {
  const match = /^hosting room (\S+) as (\S+),/.exec(hosted);
  assert.ok(match !== null, `session_host answered something else: ${hosted}`);
  return match[1] as string;
}

function inviteOf(hosted: string): string {
  const match = /^invite: (\S+)$/m.exec(hosted);
  assert.ok(match !== null, `session_host answered no invite URL: ${hosted}`);
  return match[1] as string;
}

/** How many times `needle` appears in `hay`. */
function copies(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

test('a guest types, the host waits, reads and edits: the document stays one copy', { timeout: STEP_MS * 4 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-edits-host');
  const guestFolder = await scratch('e2e-edits-guest');
  await put(hostFolder, 'notes.md', BEFORE);

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: {
      ...process.env,
      SELVAGE_SERVER_URL: selvaged.wsBase,
      SELVAGE_DISPLAY_NAME: 'pi',
      SELVAGE_PUBLISH_CURSOR: '1',
    },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'user', SELVAGE_PUBLISH_CURSOR: '1' },
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

  // The person types a line between the scratch bullet and the Try this heading.
  await guest.call('edit_file', {
    path: 'notes.md',
    old_string: '## Try this',
    new_string: `${PERSON}\n\n## Try this`,
  });

  // The host waits for it, as the live session's host did before its edits.
  const wait = await host.raw('wait_for_change', { paths: ['notes.md'], timeout_ms: 20_000 }, STEP_MS * 2);
  assert.ok(!wait.startsWith('no change within'), `the wait timed out instead of returning the edit: ${wait}`);
  assert.match(wait, /^notes\.md: changed \(\d+ characters now\)$/m, wait);

  // The host reads the document as the room holds it, then edits three times in a row.
  const read = await host.call('read_file', { path: 'notes.md' });
  assert.equal(copies(read, PERSON), 1, `the room held the person's line ${copies(read, PERSON)} times before the edits`);

  const first = await host.call('edit_file', {
    path: 'notes.md',
    old_string: '- [ ] when you join',
    new_string: '- [x] when you join',
  });
  assert.match(first, /1 replacement\(s\)/, first);
  const second = await host.call('edit_file', {
    path: 'notes.md',
    old_string: PERSON,
    new_string: `${PERSON}\n\n${REPLY}`,
  });
  assert.match(second, /1 replacement\(s\)/, second);
  const third = await host.call('edit_file', {
    path: 'notes.md',
    old_string: '- [ ] replace this line',
    new_string: '- [ ] replace this line with anything',
    replace_all: true,
  });
  assert.match(third, /1 replacement\(s\)/, third);

  // The room's own text, read by the seat that typed into it, and the host's folder.
  const inRoom = await guest.call('read_file', { path: 'notes.md' });
  const onDisk = await readFile(join(hostFolder, 'notes.md'), 'utf8');

  for (const part of ['# Notes', 'Host: pi', '## Scratch', '- [x] when you join', PERSON, REPLY, '## Try this']) {
    assert.equal(copies(inRoom, part), 1, `the room holds ${JSON.stringify(part)} ${copies(inRoom, part)} times:\n${inRoom}`);
    assert.equal(copies(onDisk, part), 1, `the host's folder holds ${JSON.stringify(part)} ${copies(onDisk, part)} times:\n${onDisk}`);
  }
  assert.equal(onDisk, inRoom, 'the host\'s folder and the room hold different text');
  assert.equal(await host.call('read_file', { path: 'notes.md' }), inRoom, 'the two seats read different text');
});

/**
 * The doubling a live session saw, reproduced: the host answers the person by sending back the
 * copy of the document it read *before* they typed, with the reply appended — a whole piece of
 * the document written through a line-level tool. Without the refusal the room holds that copy
 * twice, with the person's own line appearing once, which is exactly what they reported.
 *
 * The last step is the same reply written the way the tool is for, so the test also says that
 * what is refused is the repeat and not the reply.
 */
test('a reply that writes the document again is refused, and the room keeps one copy', { timeout: STEP_MS * 4 }, async (t) => {
  const selvaged = await RealSelvaged.start();
  t.after(async () => {
    await selvaged.stop();
  });

  const hostFolder = await scratch('e2e-repeat-host');
  const guestFolder = await scratch('e2e-repeat-guest');
  await put(hostFolder, 'notes.md', BEFORE);

  const host = await Tool.start(t, 'host', {
    cwd: hostFolder,
    env: { ...process.env, SELVAGE_SERVER_URL: selvaged.wsBase, SELVAGE_DISPLAY_NAME: 'pi' },
  });
  const guest = await Tool.start(t, 'guest', {
    cwd: guestFolder,
    env: { ...process.env, SELVAGE_DISPLAY_NAME: 'user' },
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

  // What the host holds when it reads before the person types: the document as it then stood.
  const remembered = await host.call('read_file', { path: 'notes.md' });
  assert.equal(remembered, BEFORE, 'the host read something other than the folder');

  await guest.call('edit_file', {
    path: 'notes.md',
    old_string: '## Try this',
    new_string: `${PERSON}\n\n## Try this`,
  });
  const wait = await host.raw('wait_for_change', { paths: ['notes.md'], timeout_ms: 20_000 }, STEP_MS * 2);
  assert.ok(!wait.startsWith('no change within'), `the wait timed out: ${wait}`);

  const refused = await host.raw('edit_file', {
    path: 'notes.md',
    old_string: '- [ ] replace this line with anything and watch the wait fire',
    new_string: `${remembered}${REPLY}\n`,
  });
  assert.ok(refused.startsWith('refused: '), `the reply was not refused: ${refused}`);
  assert.match(refused, /again/);
  assert.match(refused, /write_file/);

  const afterRefusal = await guest.call('read_file', { path: 'notes.md' });
  for (const part of ['# Notes', '## Scratch', '- [ ] when you join', PERSON, '## Try this']) {
    assert.equal(
      copies(afterRefusal, part),
      1,
      `the room holds ${JSON.stringify(part)} ${copies(afterRefusal, part)} times after a refused edit:\n${afterRefusal}`,
    );
  }
  assert.ok(!afterRefusal.includes(REPLY), `the refused reply reached the room:\n${afterRefusal}`);

  // The same reply, written as an edit: the person's line, and the reply under it.
  const replied = await host.call('edit_file', {
    path: 'notes.md',
    old_string: PERSON,
    new_string: `${PERSON}\n\n${REPLY}`,
  });
  assert.match(replied, /1 replacement\(s\)/, replied);
  const inRoom = await guest.call('read_file', { path: 'notes.md' });
  const onDisk = await readFile(join(hostFolder, 'notes.md'), 'utf8');
  for (const part of ['# Notes', '## Scratch', '- [ ] when you join', PERSON, REPLY, '## Try this']) {
    assert.equal(copies(inRoom, part), 1, `the room holds ${JSON.stringify(part)} ${copies(inRoom, part)} times:\n${inRoom}`);
  }
  assert.equal(onDisk, inRoom, 'the host\'s folder and the room hold different text');
});
