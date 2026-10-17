/**
 * Bounded waiting, for a test that has to observe something a live engine does on its own.
 *
 * Nothing here sleeps and hopes: a wait re-reads the real state, ends at a deadline, and fails
 * with the last thing it saw rather than with a timeout nobody can diagnose.
 */

import assert from 'node:assert/strict';

/** How long any single wait may take before the test is failed with what was observed. */
export const WAIT_MS = 10_000;

/** How often a wait re-reads the state between two things it cannot be told about. */
const POLL_MS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function until<T>(
  what: string,
  observed: () => T | Promise<T>,
  holds: (value: T) => boolean,
  ms: number = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await observed();
    if (holds(value)) {
      return value;
    }
    if (Date.now() >= deadline) {
      assert.fail(`${what} did not happen within ${ms} ms: the last observation was ${JSON.stringify(value)}`);
    }
    await delay(POLL_MS);
  }
}
