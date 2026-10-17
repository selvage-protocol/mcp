/**
 * Temporary folders for the tests that need a real file system: the grant's walk, and the clamp
 * it holds a read of a granted path to.
 *
 * They live under this checkout's `.tmp/`, never `/tmp` — on hosts where `/tmp` is a RAM-backed
 * tmpfs, a test that fills it takes the machine with it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The checkout's own scratch directory, which mirrors what `scripts/ci-local.sh` exports. */
export const TMP = fileURLToPath(new URL('../../.tmp/', import.meta.url));

/** A fresh empty folder, named for what makes it. */
export async function scratch(name: string): Promise<string> {
  await mkdir(TMP, { recursive: true });
  return await mkdtemp(join(TMP, `${name}-`));
}

/** Writes a file under `root`, creating the directories it names. */
export async function put(root: string, path: string, text: string): Promise<void> {
  const at = join(root, path);
  await mkdir(join(at, '..'), { recursive: true });
  await writeFile(at, text, 'utf8');
}

export async function remove(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
