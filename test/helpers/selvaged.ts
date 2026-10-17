/**
 * The real `selvaged`, spawned the way a client reaches a room: the Rust reference server, its
 * address read off what it prints, its process killed however the test leaves.
 *
 * A proof that needs a server binary and silently skips when it is missing is not a proof, so a
 * missing binary fails here, naming the command that builds it. The binary is found the way the
 * workspace's own harnesses find it: `SELVAGE_SELVAGED` first, then a sibling
 * `reference_server`'s build, walked for from this checkout's directory upward so a worktree
 * beside the checkout resolves the same build.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What to run when no binary is there. */
const BUILD_HINT =
  "nix develop ../reference_server -c sh -c 'cd ../reference_server && cargo build -p selvaged'";

/** How long the server has to print its address, and how long SIGTERM has to land. */
const START_MS = 15_000;
const STOP_MS = 2_000;

/** Where the binary is, or a failure naming what builds it. */
export function selvagedBinary(from: string = dirname(fileURLToPath(import.meta.url))): string {
  const named = process.env['SELVAGE_SELVAGED'];
  if (named !== undefined && named !== '' && existsSync(named)) {
    return named;
  }
  let at = from;
  for (;;) {
    for (const profile of ['debug', 'release']) {
      const candidate = join(at, 'reference_server', 'target', profile, 'selvaged');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    const up = dirname(at);
    if (up === at) {
      break;
    }
    at = up;
  }
  assert.fail(
    `the end-to-end proof needs a real selvaged and none is here: looked under ${from} and upward for a sibling reference_server's build, and SELVAGE_SELVAGED is ${named === undefined ? 'unset' : JSON.stringify(named)}. Build it with: ${BUILD_HINT}`,
  );
}

interface ExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** One `selvaged` process, listening on a port the kernel chose. */
export class RealSelvaged {
  private address = '';
  private readonly child: ChildProcess;
  private readonly out: string[] = [];
  private exited: ExitState | undefined;

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      this.out.push(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.out.push(chunk.toString('utf8'));
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
    });
  }

  /** The address a client dials: the host and port of the printed `ws://…/session`. */
  get wsBase(): string {
    return `ws://${this.address}`;
  }

  /** The port the kernel gave it, which is what a failure message should name. */
  get hostPort(): string {
    return this.address;
  }

  /** Everything the server has written, for a failure message. */
  get output(): string {
    return this.out.join('');
  }

  static async start(): Promise<RealSelvaged> {
    const binary = selvagedBinary();
    const child = spawn(binary, ['--listen', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const server = new RealSelvaged(child);
    server.address = await server.printed(START_MS);
    return server;
  }

  /** Waits for the address the server prints, or fails with everything it did print. */
  private async printed(ms: number): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
      const match = /ws:\/\/([0-9.]+:[0-9]+)\/session/.exec(this.output);
      if (match !== null) {
        return match[1] as string;
      }
      if (this.exited !== undefined) {
        assert.fail(`selvaged exited before it printed an address: ${this.report()}`);
      }
      if (Date.now() >= deadline) {
        assert.fail(`selvaged printed no address within ${ms} ms: ${this.report()}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }

  /** SIGTERM, then SIGKILL, and it is gone either way. */
  async stop(): Promise<void> {
    if (this.exited !== undefined) {
      return;
    }
    this.child.kill('SIGTERM');
    const gone = await Promise.race([
      new Promise<boolean>((resolve) => {
        this.child.once('exit', () => {
          resolve(true);
        });
      }),
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, STOP_MS);
      }),
    ]);
    if (!gone) {
      this.child.kill('SIGKILL');
    }
  }

  report(): string {
    return `selvaged said: ${JSON.stringify(this.output)}; exit: ${JSON.stringify(this.exited ?? 'still running')}`;
  }
}
