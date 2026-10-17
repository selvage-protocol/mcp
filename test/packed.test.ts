/**
 * The package as a consumer gets it: `npm pack`ed here, installed outside this checkout, and
 * started from the command `bin` names. What a checkout can show is not this — `npm test` runs
 * the sources, and a tarball that names a file it does not carry, or a `bin` that points at
 * TypeScript, answers only to an install somewhere else. So the install happens under `.tmp/`
 * (`/tmp` is a RAM-backed tmpfs on some hosts), the tarball goes in, and the installed command
 * answers a real client: `initialize`, then `tools/list`, over its own stdio.
 *
 * The project it is installed into starts as a copy of this checkout's own `node_modules`, hidden
 * lockfile and all, because a build sandbox has no registry and npm resolves an offline install
 * against that lockfile rather than against the network. Nothing about the result is the seed's:
 * npm reifies the tree the tarball and its `dependencies` ask for and prunes the rest, so a
 * package the manifest forgot to declare is gone before the command runs and the run fails on it.
 *
 * Nothing here skips. A build that fails fails `npm pack`; a tarball missing the artifact fails
 * the assertion on the installed tree; an artifact that cannot resolve what it imports fails the
 * handshake, with the server's own stderr in the message.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { remove, scratch, TMP } from './helpers/scratch.ts';
import { startFile } from './helpers/stdio-client.ts';
import { TOOL_NAMES } from './helpers/tool-names.ts';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Record<string, string>;
};

/** What `npm` was asked and what it said, for a failure a reader can act on. */
async function npm(args: readonly string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('npm', [...args], {
      cwd,
      // The install is the point and the network is not: everything it needs is already in the
      // tree beside it, and `--offline` is what makes that a requirement rather than a hope.
      env: { ...process.env, TMPDIR: TMP, NO_UPDATE_NOTIFIER: '1' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const said = error as { readonly message: string; readonly stdout?: string; readonly stderr?: string };
    throw new Error(
      `npm ${args.join(' ')} in ${cwd} failed: ${said.message}\n` +
        `${said.stdout ?? ''}${said.stderr ?? ''}`,
    );
  }
}


test('the packed tarball installs outside the checkout and its command answers a client', { timeout: 300_000 }, async (t) => {
  const into = await scratch('packed');

  // `npm pack` runs `prepare`, which builds the artifact, so what lands in the tarball is what a
  // publish or a git install would carry rather than whatever a checkout happens to hold.
  await npm(['pack', '--pack-destination', into, '--no-audit', '--no-fund'], root);
  const tarballs = readdirSync(into).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, `npm pack wrote ${tarballs.join(', ') || 'nothing'}`);
  const tarball = join(into, tarballs[0] as string);

  // A project of its own, outside this checkout, seeded with the tree this checkout installed
  // and given a package.json that names nothing: what ends up in it is what the tarball asks for.
  const project = join(into, 'consumer');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'packed-probe', version: '1.0.0', private: true }, null, 2)}\n`,
  );
  cpSync(join(root, 'node_modules'), join(project, 'node_modules'), {
    recursive: true,
    // The checkout's `node_modules` is a real directory; the one a Nix check builds is a symlink
    // into the store, and the copy is of what it points at rather than of the link.
    dereference: true,
  });
  await npm(['install', '--offline', '--no-save', '--no-audit', '--no-fund', tarball], project);

  // What the tarball carries, which is `files` and what npm adds to it.
  const installed = join(project, 'node_modules', manifest.name);
  assert.ok(
    existsSync(join(installed, 'dist', 'main.js')),
    `the tarball carries no dist/main.js: ${readdirSync(installed).join(', ')}`,
  );
  // The artifact is a directory of chunks, and `files` is what carries all of them: npm always
  // packs the file `bin` names, so a `files` that forgot the rest is a main.js that starts and
  // cannot load what it imports.
  assert.deepEqual(
    readdirSync(join(installed, 'dist')).sort(),
    readdirSync(join(root, 'dist')).sort(),
    'the tarball carries a different artifact than the build wrote',
  );
  for (const wanted of ['package.json', 'README.md', 'LICENSE-MIT', 'LICENSE-APACHE']) {
    assert.ok(existsSync(join(installed, wanted)), `${wanted} is missing from the tarball`);
  }
  for (const unwanted of ['src', 'vendor', 'test', 'scripts', 'flake.nix', 'tsconfig.json']) {
    assert.ok(!existsSync(join(installed, unwanted)), `${unwanted} is in the tarball, and no consumer needs it`);
  }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    assert.ok(
      existsSync(join(project, 'node_modules', name)),
      `${name} did not survive the install, and the engine imports it`,
    );
  }
  // The install was the tarball's, not the seed's: what only a checkout needs is not there.
  for (const name of ['esbuild', 'typescript', '@modelcontextprotocol/sdk']) {
    assert.ok(
      !existsSync(join(project, 'node_modules', name)),
      `${name} survived into a consumer's tree, and only this checkout installs it`,
    );
  }

  // The command an MCP client is configured with: the one npm put on the path, run the way a
  // shell runs it.
  const command = join(project, 'node_modules', '.bin', manifest.name);
  assert.ok(existsSync(command), `the install left no ${manifest.name} command`);
  const { server, how } = startFile(command, { cwd: project });
  t.after(() => server.stop());

  server.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'packed-probe', version: '1' },
    },
  });
  const hello = (await server.nextResult(1, `the initialize result, from the installed command run ${how}`)) as {
    readonly protocolVersion?: unknown;
    readonly serverInfo?: { readonly name?: unknown; readonly version?: unknown };
  };
  assert.equal(hello.serverInfo?.name, manifest.name, `the installed server named itself ${JSON.stringify(hello.serverInfo)}`);
  assert.equal(
    hello.serverInfo?.version,
    manifest.version,
    'the version the installed server announced is not the one it was installed as',
  );

  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const listed = (await server.nextResult(2, 'the tools/list result')) as {
    readonly tools?: readonly { readonly name?: unknown }[];
  };
  assert.ok(Array.isArray(listed.tools), `tools/list answered ${JSON.stringify(listed)}`);
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    TOOL_NAMES,
    'the installed server does not serve the nine tools',
  );

  assert.equal((await server.close()).code, 0, server.report());

  // Removed at the end of the body rather than from an `after` hook, so an install that went
  // wrong is still on disk to be read.
  await remove(into);
});
