/**
 * The vendored copy is the sync engine and the bridge, copied here by `scripts/sync-engine.sh`
 * from the VS Code client. What keeps the copy usable from a server is that it never reaches for
 * the editor it was written beside: an import of `vscode` anywhere under `vendor/` means the
 * script copied something that does not belong here, and it is cheaper to fail on that than to
 * discover it at run time.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../vendor', import.meta.url));

function sources(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sources(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

test('the vendored engine and bridge are there', () => {
  // The two entry points this repository imports from, and not a module behind them: what the
  // copy has to be is the seam, and which files the seam is made of is the source's business.
  const files = sources(root).map((path) => path.slice(root.length + 1));
  assert.ok(files.includes(join('engine', 'index.ts')), files.join(', '));
  assert.ok(files.includes(join('bridge', 'index.ts')), files.join(', '));
});

test('nothing under vendor/ imports an editor', () => {
  for (const path of sources(root)) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/from\s+'([^']+)'/g)) {
      assert.notEqual(match[1], 'vscode', `${path} imports vscode`);
    }
  }
});
