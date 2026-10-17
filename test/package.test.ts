/**
 * The two claims a package makes before any of its code runs: what `bin` says can be started, and
 * what the imports need in order to resolve. Both are checkable, and an untrue one is a defect
 * that a client discovers instead of a test.
 *
 * `bin.selvage-mcp` points at `dist/main.js`, which `npm run build` writes and `prepare` runs — so
 * a checkout that has installed its dependencies has it, and one that has not is a failure here
 * rather than a pass. This file starts the declared target the way the shell would — through the
 * file's own shebang — rather than through `node <path>`, so the claim that it is startable is the
 * claim actually tested. What the packed package does with it is `packed.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startFile } from './helpers/stdio-client.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  bin: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

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

/** Every module specifier under `src/` and `vendor/`, as written. */
function specifiers(): string[] {
  const found: string[] = [];
  for (const dir of ['src', 'vendor']) {
    for (const path of sources(join(root, dir))) {
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
        found.push(match[1] as string);
      }
    }
  }
  return found;
}

test('the command `bin` names exists, is executable, and runs the server', async (t) => {
  const target = manifest.bin['selvage-mcp'];
  assert.equal(typeof target, 'string', 'the package promises a command');
  const path = join(root, target as string);

  const first = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  assert.match(first, /^#!\/usr\/bin\/env node$/, `the target starts with ${JSON.stringify(first)}`);
  assert.ok(
    (statSync(path).mode & 0o111) !== 0,
    `${target} is not executable, so the shebang is decoration`,
  );

  // The shebang names `/usr/bin/env`, and a Nix build sandbox has no `/usr/bin` at all, so the
  // kernel cannot exec the file there at all; `startFile` is the two branches, and the failure
  // message says which one ran it.
  const { server, how } = startFile(path);
  t.after(() => server.stop());
  server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const what = `a ping answered by the command \`bin\` names, run ${how}`;
  assert.deepEqual(await server.nextResult(1, what), {});
  assert.equal((await server.close()).code, 0, server.report());

  // The suite is TypeScript, and `node --test` strips the types without being asked from 22.18
  // on; the artifact the package ships is built for the same floor.
  const floor = (manifest.engines?.node ?? '').replace(/^[^0-9]*/, '');
  const [major, minor] = floor.split('.').map(Number) as [number, number];
  assert.ok(
    major > 22 || (major === 22 && minor >= 18),
    `engines.node is "${floor}", and the suite's own TypeScript needs 22.18`,
  );
});

test('every bare specifier is declared, and the engine sits in `dependencies`', () => {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const bare = new Set<string>();
  for (const specifier of specifiers()) {
    if (specifier.startsWith('.') || specifier.startsWith('node:')) {
      continue;
    }
    bare.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] as string));
  }
  assert.ok(bare.size > 0, 'the scan found no bare specifiers at all, which cannot be right');
  for (const name of bare) {
    assert.ok(
      declared[name] !== undefined,
      `${name} is imported but not declared, so the install would not carry it`,
    );
  }

  // The engine runs in production, and a package that only resolves under `--include=dev` is a
  // server that starts on a developer's machine and nowhere else.
  for (const name of ['lib0', 'ws', 'y-protocols', 'yjs']) {
    assert.ok(manifest.dependencies?.[name] !== undefined, `${name} belongs in dependencies`);
    assert.equal(manifest.devDependencies?.[name], undefined, `${name} is not a dev dependency`);
  }
  assert.ok(manifest.devDependencies?.['@types/ws'] !== undefined, '@types/ws belongs in dev');
  assert.equal(manifest.dependencies?.['@types/ws'], undefined, 'a types-only package is not runtime');

  // The build tool is not the server: an installed package runs `dist/`, which `prepare` wrote
  // before the tarball was packed, so nothing at run time reaches for a bundler.
  assert.ok(manifest.devDependencies?.['esbuild'] !== undefined, 'esbuild belongs in dev');
  assert.equal(manifest.dependencies?.['esbuild'], undefined, 'a build tool is not runtime');
});
