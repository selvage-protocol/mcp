/**
 * The session against a real file system: the walk a host publishes, and the clamp every read of
 * a granted path goes through — including the shape the clamp is not written for, a **directory**
 * that has become a symbolic link out of the folder.
 *
 * The folders are under this checkout's `.tmp/`, never `/tmp`.
 */

import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { MAX_GRANT_FILE_BYTES } from '../vendor/bridge/index.ts';
import { enumerateGrant, writeGrantedFile } from '../src/grant.ts';
import { Session, SessionRefused } from '../src/session.ts';
import type { SessionRefusal } from '../src/session.ts';
import { StubEngine, StubFactory } from './helpers/stub-engine.ts';
import { put, remove, scratch } from './helpers/scratch.ts';
import { until } from './helpers/until.ts';

const INVITE = `ws://room.example/session?room=room-1&token=tok-1#k=${'a'.repeat(43)}&h=${'b'.repeat(43)}`;

function refused(code: SessionRefusal): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof SessionRefused, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    return true;
  };
}

/** A host whose engine is a stub that already holds the listing the walk produced. */
async function hostOver(
  root: string,
  engine: StubEngine,
): Promise<{ session: Session; engine: StubEngine }> {
  const factory = new StubFactory(engine);
  const session = new Session({ engines: factory, documentWaitMs: 200 });
  await session.host({ root, serverUrl: 'ws://room.example', displayName: 'agent' });
  return { session, engine };
}

test('a host publishes the walk: the excludes, the ignore files and no descent into a link', async () => {
  const root = await scratch('walk');
  const outside = await scratch('walk-outside');
  try {
    await put(root, 'a.txt', 'a');
    await put(root, 'Zed.txt', 'z');
    await put(root, 'sub/one.txt', 'one');
    await put(root, 'sub/two.txt', 'two');
    await put(root, 'ignored.txt', 'ignored by the folder');
    await put(root, 'kept-back.txt', 'kept by a later pattern');
    await put(root, '.gitignore', 'ignored.txt\n!kept-back.txt\n');
    await put(root, 'from-outside.txt', 'ignored by the repository');
    await put(root, 'kept-back.txt', 'kept by a later pattern');
    await put(root, '.git/info/exclude', 'from-outside.txt\nkept-back.txt\n');
    await put(root, 'node_modules/dep/index.js', 'an excluded directory');
    await put(root, '.ssh/id_rsa', 'a secret directory');
    await put(root, '.env', 'a secret file');
    await put(root, 'secret.pem', 'a secret key');
    await put(outside, 'escaped.txt', 'outside the folder');

    // A link here is not a file of this folder, so the walk neither names it nor reads through
    // it: what it is a link to is not this host's to publish.
    await symlink(outside, join(root, 'link'));

    const walked = await enumerateGrant(root);
    assert.deepEqual(walked.paths, [
      '.gitignore',
      'Zed.txt',
      'a.txt',
      'kept-back.txt',
      'sub/one.txt',
      'sub/two.txt',
    ]);
    assert.equal(walked.cut, undefined);
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('a room path under a directory that became a link out of the folder is refused, not read', async () => {
  const root = await scratch('clamp');
  const outside = await scratch('clamp-outside');
  try {
    await put(root, 'a.txt', 'a');
    await put(root, 'sub/x.txt', 'inside the folder\n');
    await put(outside, 'x.txt', 'outside the folder\n');

    // The listing is taken while `sub` is an ordinary directory of the folder, and the room names
    // the path from it — which is the whole of what a listing is: a name a peer is holding.
    const walked = await enumerateGrant(root);
    assert.deepEqual(walked.paths, ['a.txt', 'sub/x.txt']);

    const engine = new StubEngine({
      role: 'host',
      invite: INVITE,
      listing: walked.paths,
      documents: ['sub/x.txt'],
    });
    const { session } = await hostOver(root, engine);

    await rm(join(root, 'sub'), { recursive: true });
    await symlink(outside, join(root, 'sub'));

    await assert.rejects(session.read('sub/x.txt'), refused('not-a-file'));
    assert.equal(engine.texts.has('sub/x.txt'), false);
    assert.deepEqual(
      engine.calls.filter((call) => call.startsWith('insert')),
      [],
    );
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('a granted file that became a link out of the folder is refused at the leaf', async () => {
  const root = await scratch('leaf');
  const outside = await scratch('leaf-outside');
  try {
    await put(root, 'leaf.txt', 'inside the folder\n');
    await put(outside, 'elsewhere.txt', 'outside the folder\n');
    const walked = await enumerateGrant(root);
    assert.deepEqual(walked.paths, ['leaf.txt']);

    const engine = new StubEngine({ role: 'host', invite: INVITE, listing: walked.paths });
    const { session } = await hostOver(root, engine);

    await rm(join(root, 'leaf.txt'));
    await symlink(join(outside, 'elsewhere.txt'), join(root, 'leaf.txt'));

    await assert.rejects(session.read('leaf.txt'), refused('not-a-file'));
    assert.equal(engine.texts.has('leaf.txt'), false);
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('a host answers a hold from its own folder, and a read goes through the shareable gate', async () => {
  const root = await scratch('seed');
  try {
    await put(root, 'a.txt', 'from the folder\n');
    const walked = await enumerateGrant(root);
    const engine = new StubEngine({ role: 'host', invite: INVITE, listing: walked.paths });
    const { session } = await hostOver(root, engine);

    // The room is holding a path: a hold on a path nothing has arrived for is the ask, and the
    // host's answer is its own file, read through the clamp.
    engine.emit({ type: 'documentsChanged', documents: ['a.txt'] });
    await until(
      'the host to seed a.txt',
      () => engine.text('a.txt'),
      (text) => text === 'from the folder\n',
    );

    // A path the grant would never name, named by the room, is refused and nothing is published.
    engine.emit({ type: 'documentsChanged', documents: ['../outside.txt'] });
    const problems = await until(
      'the refused seed to be recorded',
      () => session.status().problems,
      (rows) => rows.length > 0,
    );
    assert.equal(problems[0]?.path, '../outside.txt');
    assert.equal(problems[0]?.cause, 'not-granted');
    assert.deepEqual(engine.calls.filter((call) => call.includes('outside.txt')), []);

    // A read of a listed path answers with the room's text, which the host itself seeded.
    const read = await session.read('a.txt');
    assert.equal(read.text, 'from the folder\n');
  } finally {
    await remove(root);
  }
});

test('a host seeds a path once while a second ask for it is in flight', async () => {
  const root = await scratch('one-seed');
  try {
    const body = 'from the folder\n';
    await put(root, 'a.txt', body);
    const walked = await enumerateGrant(root);
    // The room says it is holding the path while this process is opening it. With the real
    // engine that is the hold's own echo arriving during `open`, and it starts a seed that is
    // still reading the folder when the read that took the hold asks for the same document:
    // two callers of one seed, one of them the room's event and one of them the read.
    const engine = new StubEngine({
      role: 'host',
      invite: INVITE,
      listing: walked.paths,
      onOpen: (path, stub) => {
        if (path === 'a.txt') {
          stub.emit({ type: 'documentsChanged', documents: ['a.txt'] });
        }
      },
    });
    const { session } = await hostOver(root, engine);

    const read = await session.read('a.txt');
    assert.equal(read.text, body, 'the read answered with the seeded text');
    assert.equal(
      await until(
        'a.txt to hold the folder text once',
        () => engine.text('a.txt'),
        (text) => text === body,
        1_000,
      ),
      body,
    );
    // One insertion, not two: the second ask joined the seed already reading the folder.
    assert.deepEqual(
      engine.calls.filter((call) => call.startsWith('insert ')),
      [`insert a.txt 0 ${JSON.stringify(body)}`],
    );
  } finally {
    await remove(root);
  }
});

test('a host puts the room\'s changes on disk, and does not create what the folder lacks', async () => {
  const root = await scratch('apply');
  try {
    await put(root, 'a.txt', 'one\n');
    const walked = await enumerateGrant(root);
    const engine = new StubEngine({
      role: 'host',
      invite: INVITE,
      listing: walked.paths,
      texts: new Map([['a.txt', 'one\n']]),
    });
    const { session } = await hostOver(root, engine);

    engine.remote('a.txt', 'two\n');
    engine.emit({ type: 'documentChanged', path: 'a.txt' });
    const applied = await until(
      'the folder to hold the room\'s text',
      () => readFile(join(root, 'a.txt'), 'utf8'),
      (text) => text === 'two\n',
    );
    assert.equal(applied, 'two\n');
    assert.deepEqual(session.status().problems, []);

    // The room has a file this folder does not: creating it means resolving every directory on
    // the way with the same hold, so it is refused and said out loud rather than half-written.
    engine.remote('new.txt', 'from the room\n');
    engine.emit({ type: 'documentChanged', path: 'new.txt' });
    const problems = await until(
      'the refused write to be recorded',
      () => session.status().problems,
      (rows) => rows.length > 0,
    );
    assert.equal(problems[0]?.path, 'new.txt');
    assert.equal(problems[0]?.cause, 'missing');
    assert.equal(existsSync(join(root, 'new.txt')), false);
  } finally {
    await remove(root);
  }
});

test('a second change for a path waits for the write-back before it, and the last text lands', async () => {
  const root = await scratch('write-back-order');
  try {
    // Two changes for one path, the second landing in the window the first write-back opens
    // between reading the replica and writing the folder — a peer typing faster than the folder
    // follows. A write-back is a read, an emptying and a write of the same leaf, so two of them
    // overlapped can leave one text's head over another's tail, or leave the older text on disk
    // with no further change coming to correct it. The folder and the room both hold a
    // session-wide text here, because that is what makes each of those reads long enough for the
    // window to be a real one on this machine.
    const wide = 'x'.repeat(MAX_GRANT_FILE_BYTES - 32);
    const older = `${'A'.repeat(MAX_GRANT_FILE_BYTES - 32)}\n`;
    const newer = 'new\n';
    // Three landings, each one a race the chain has to lose nothing in.
    for (let round = 0; round < 3; round += 1) {
      await put(root, 'a.txt', `${wide}\n`);
      let landed = false;
      const engine = new StubEngine({
        role: 'host',
        invite: INVITE,
        listing: ['a.txt'],
        documents: ['a.txt'],
        texts: new Map([['a.txt', older]]),
        // The room moves on while the write-back has the text it read and has not written it.
        onText: (path, stub) => {
          if (!landed) {
            landed = true;
            stub.remote(path, newer);
            stub.emit({ type: 'documentChanged', path });
          }
        },
      });
      const { session } = await hostOver(root, engine);
      engine.emit({ type: 'documentChanged', path: 'a.txt' });
      const text = await until(
        'the folder to hold the room\'s last text',
        () => readFile(join(root, 'a.txt'), 'utf8'),
        (current) => current === newer,
        3_000,
      );
      assert.equal(text, newer, `round ${round} holds a mixture of two changes`);
      await session.leave();
    }
  } finally {
    await remove(root);
  }
});

test('a host keeps its own folder true to an edit it applied, and a guest writes nothing', async () => {
  const root = await scratch('own-edit');
  try {
    await put(root, 'a.txt', 'one\n');
    const walked = await enumerateGrant(root);
    // `onText` is the room's own text being read by a write-back, which is the point a write-back
    // has looked at both sides of the comparison it decides with.
    let echoed = 0;
    const engine = new StubEngine({
      role: 'host',
      invite: INVITE,
      listing: walked.paths,
      documents: ['a.txt'],
      texts: new Map([['a.txt', 'one\n']]),
      onText: () => {
        echoed += 1;
      },
    });
    const { session } = await hostOver(root, engine);

    const outcome = await session.write('a.txt', 'two\n');
    assert.equal(outcome.disk, 'written');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'two\n');
    // The room's own echo of that edit is not a second write, and the assertion is made after the
    // write-back it starts has read the room rather than beside it: an echo that had a problem to
    // record or a second write to make would have made it by this point.
    const beforeEcho = echoed;
    engine.emit({ type: 'documentChanged', path: 'a.txt' });
    await until('the room\'s echo to be read', () => echoed, (seen) => seen > beforeEcho, 1_000);
    assert.deepEqual(session.status().problems, []);
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'two\n');

    // A guest has no folder of its own, so an incoming change is a document and nothing else.
    let guestReads = 0;
    const guestEngine = new StubEngine({
      listing: ['a.txt'],
      documents: ['a.txt'],
      texts: new Map([['a.txt', 'one\n']]),
      onText: () => {
        guestReads += 1;
      },
    });
    const guest = new Session({ engines: new StubFactory(guestEngine) });
    await guest.join({ invite: INVITE, displayName: 'agent' });
    guestEngine.remote('a.txt', 'from the room\n');
    guestEngine.emit({ type: 'documentChanged', path: 'a.txt' });
    // The host's own echo, landed after the guest's change, is the clock for the guest's step:
    // its write-back is answered in the turn it is queued in, before it could ask the room for
    // anything, so a host write-back that has since read the folder is long past it.
    const beforeGuest = echoed;
    engine.emit({ type: 'documentChanged', path: 'a.txt' });
    await until('the host\'s later echo to be read', () => echoed, (seen) => seen > beforeGuest, 1_000);
    assert.deepEqual(guest.status().problems, []);
    assert.deepEqual(guestEngine.calls.filter((call) => /^(open|insert|delete)/.test(call)), []);
    assert.equal(guestReads, 0, 'a guest asks the room for no text, having no folder to write it to');
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'two\n');
  } finally {
    await remove(root);
  }
});

test('a write into the shared folder resolves the path itself, so a link swapped in is refused', async () => {
  const root = await scratch('write-clamp');
  const outside = await scratch('write-clamp-outside');
  try {
    await put(root, 'sub/x.txt', 'inside the folder\n');
    await put(root, 'leaf.txt', 'inside the folder\n');
    await put(outside, 'x.txt', 'outside the folder\n');
    await put(outside, 'elsewhere.txt', 'outside the folder\n');

    // A plain file of the folder when the room's change was read — which is the state the walk
    // recorded and the read accepts — and a link by the time the write happens. A write that
    // resolves the name again follows it out of the grant; the clamp refuses it where it opens.
    await rm(join(root, 'sub'), { recursive: true });
    await symlink(outside, join(root, 'sub'));
    await rm(join(root, 'leaf.txt'));
    await symlink(join(outside, 'elsewhere.txt'), join(root, 'leaf.txt'));

    assert.deepEqual(await writeGrantedFile(root, 'sub/x.txt', 'from the room\n'), {
      kind: 'refused',
      cause: 'not-a-file',
    });
    assert.deepEqual(await writeGrantedFile(root, 'leaf.txt', 'from the room\n'), {
      kind: 'refused',
      cause: 'not-a-file',
    });
    assert.equal(await readFile(join(outside, 'x.txt'), 'utf8'), 'outside the folder\n');
    assert.equal(await readFile(join(outside, 'elsewhere.txt'), 'utf8'), 'outside the folder\n');

    // And a path the folder holds is written through the same clamp, whole.
    await put(root, 'kept.txt', 'one\n');
    assert.deepEqual(await writeGrantedFile(root, 'kept.txt', 'two\n'), { kind: 'written' });
    assert.equal(await readFile(join(root, 'kept.txt'), 'utf8'), 'two\n');

    // A path the folder does not hold is refused rather than created.
    assert.deepEqual(await writeGrantedFile(root, 'new.txt', 'from the room\n'), {
      kind: 'refused',
      cause: 'missing',
    });
    assert.equal(existsSync(join(root, 'new.txt')), false);
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('a write lands the text it was given whole, and nothing of a longer one behind', async () => {
  const root = await scratch('write-whole');
  try {
    // The text is read back rather than the write's answer taken for it, because the answer is
    // what a write reported while the file is what the host's folder now holds. A write replaces
    // the file rather than overwriting it in place, so the text written is the whole of it: none
    // of a longer text before it may survive past the new one's end.
    await put(root, 'a.txt', 'ada types here\n');
    assert.deepEqual(await writeGrantedFile(root, 'a.txt', 'grace types here\n'), { kind: 'written' });
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'grace types here\n');

    assert.deepEqual(await writeGrantedFile(root, 'a.txt', 'bo\n'), { kind: 'written' });
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'bo\n');

    // And a longer text over that shorter one is the shorter one replaced in full.
    assert.deepEqual(await writeGrantedFile(root, 'a.txt', 'a longer line again\n'), { kind: 'written' });
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'a longer line again\n');
  } finally {
    await remove(root);
  }
});

test('a write reaches a nested path through the directories the folder holds', async () => {
  const root = await scratch('write-nested');
  const outside = await scratch('write-nested-outside');
  try {
    await put(root, 'sub/deep/x.txt', 'inside the folder\n');
    await put(outside, 'x.txt', 'outside the folder\n');

    assert.deepEqual(await writeGrantedFile(root, 'sub/deep/x.txt', 'from the room\n'), {
      kind: 'written',
    });
    assert.equal(await readFile(join(root, 'sub/deep/x.txt'), 'utf8'), 'from the room\n');
    assert.equal(await readFile(join(outside, 'x.txt'), 'utf8'), 'outside the folder\n');

    // The leaf is a name of the directory that holds it, so a segment the folder does not hold is
    // the same `missing` a name that is not there is, whether or not something outside holds it.
    assert.deepEqual(await writeGrantedFile(root, 'sub/elsewhere/x.txt', 'from the room\n'), {
      kind: 'refused',
      cause: 'missing',
    });
    assert.equal(existsSync(join(root, 'sub/elsewhere')), false);
  } finally {
    await remove(root);
    await remove(outside);
  }
});

test('a leaf over the size a session carries is refused, and left as it was', async () => {
  const root = await scratch('write-bound');
  try {
    // A file this size is one the read refuses, so the room's text for it is not this host's to
    // write either. What the refusal may not do is empty the file on the way to saying no: a leaf
    // truncated as it is opened has been destroyed by the time anything about it is judged.
    const over = 'x'.repeat(MAX_GRANT_FILE_BYTES + 1);
    await put(root, 'big.txt', over);
    assert.deepEqual(await writeGrantedFile(root, 'big.txt', 'small\n'), {
      kind: 'refused',
      cause: 'too-large',
    });
    assert.equal(statSync(join(root, 'big.txt')).size, MAX_GRANT_FILE_BYTES + 1);
  } finally {
    await remove(root);
  }
});
