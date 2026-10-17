/**
 * The runnable artifact: `dist/`, built from this repository's own sources and the vendored
 * engine. `package.json`'s `bin` names `dist/main.js`, and `prepare` runs this, so a tarball,
 * a git install and a checkout all end up starting the same file.
 *
 * Why a bundle rather than a TypeScript emit. The sources import with explicit `.ts`
 * extensions — the vendored engine's included — so an emit has to rewrite every specifier to
 * `.js` and ship both trees; and `src/main.ts` reads `../package.json`, which is only the
 * package root if the entry point sits exactly one directory below it, so the emitted tree
 * cannot be `dist/src/main.js` without the sources changing how they find their own manifest.
 * One bundle has neither problem: the specifiers are resolved here, and `dist/main.js` is the
 * same one level down as `src/main.ts` is.
 *
 * The packages stay external. They are the vendored engine's own — `yjs`, `ws`, `lib0`,
 * `y-protocols` — and the engine drives them; leaving them to resolve from the installed
 * `node_modules` is what makes `dependencies` mean what it says, and what `test/packed.test.ts`
 * holds the installed tree to. `--splitting` is what keeps them out of the entry chunk:
 * esbuild hoists the imports of an external package to the top of whatever file ends up
 * needing it, so a single file would evaluate `lib0` before `src/main.ts` has answered the
 * browser-storage global `lib0` reads as it is evaluated — the warning that answer exists to
 * keep off stderr. Split, the engine lands in the chunk `src/main.ts` imports at the point it
 * imports it, and the order is the source's own.
 *
 * What it costs: the artifact is a directory of chunks rather than one file, and a stack trace
 * names `dist/main.js` and a line rather than the file under `vendor/` it came from. No
 * source map ships with it; see `NOTES-packaging.md`.
 */

import { build } from 'esbuild';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist');
const entry = resolve(root, 'src/main.ts');
const outfile = join(outdir, 'main.js');

// A fresh `dist/` every build: chunk names carry a content hash, so an incremental one
// accumulates chunks nothing imports — still packed, still installed, never loaded.
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [entry],
  outdir,
  entryNames: 'main',
  chunkNames: '[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // Every bare specifier — `yjs`, `ws`, `lib0`, `y-protocols` and a `node:` builtin alike —
  // stays an import for the runtime to resolve, and only this repository's own relative code is
  // compiled in.
  packages: 'external',
  logLevel: 'warning',
});

/** Fails the build with what was seen, so a broken artifact is red here rather than in a client. */
function refuse(what) {
  process.stderr.write(`build: ${what}\n`);
  process.exit(1);
}

if (!existsSync(outfile)) {
  refuse(`${outfile} was not written`);
}

const text = readFileSync(outfile, 'utf8');
const first = text.split('\n', 1)[0] ?? '';
if (first !== '#!/usr/bin/env node') {
  refuse(`dist/main.js starts with ${JSON.stringify(first)} rather than a shebang`);
}

// The kernel decides whether a file is executable by its mode, and npm's own install copies the
// mode the tarball carries, so the bit is set here rather than promised by `bin`.
chmodSync(outfile, 0o755);
if ((statSync(outfile).mode & 0o111) === 0) {
  refuse('dist/main.js is not executable');
}

// The entry chunk must reach nothing but the runtime's own builtins. A package imported here is
// one esbuild hoisted above the entry's own first statement, and `lib0` reads the browser-storage
// global as it is evaluated: answered too late, that read is a warning on stderr ahead of this
// server's first diagnostic. The engine belongs in the chunk `src/main.ts` imports it from.
const eager = [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)]
  .map((match) => match[1])
  .filter((specifier) => !specifier.startsWith('node:'));
if (eager.length > 0) {
  refuse(
    `the entry chunk imports ${eager.join(', ')}; a package reaches it only by being hoisted ` +
      `above the entry point, which puts it ahead of the browser-storage answer in src/main.ts`,
  );
}
