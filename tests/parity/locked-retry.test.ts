/**
 * The local D1 file is held by the dev worker while it writes, and a scenario's
 * own `d1 execute` issued at that instant is refused rather than queued. The
 * decision to ask again is a pure function so it can be checked without
 * spawning the real wrangler the target spawns.
 */
import { describe, expect, it } from 'bun:test';
import { LOCKED_BACKOFF_MS, LOCKED_RETRIES, lockedRetryWaitMs } from './targets/cloudflare.js';

const LOCKED = 'wrangler d1 execute myco-server exited 1: ✘ [ERROR] SQLITE_BUSY: database is locked';

describe('the locked-database retry', () => {
  it('asks again, waiting twice as long each time, up to its bound', () => {
    const waits = Array.from({ length: LOCKED_RETRIES + 1 }, (_, attempt) => lockedRetryWaitMs(LOCKED, attempt));
    expect(waits).toEqual([100, 200, 400, 800, 1600, null]);
    expect(waits[0]).toBe(LOCKED_BACKOFF_MS);
  });

  it('reads either word the lock is reported under, in any case', () => {
    for (const said of ['Error: database is locked', 'SQLITE_BUSY', 'sqlite_busy: Database Is Locked']) {
      expect({ said, wait: lockedRetryWaitMs(said, 0) }).toEqual({ said, wait: LOCKED_BACKOFF_MS });
    }
  });

  it('GATE: raises every other failure at once', () => {
    // A retry on anything else turns a scenario's real failure into a slow one.
    for (const said of [
      'wrangler d1 execute myco-server exited 1: no such table: agent_runs',
      'wrangler d1 execute exited 1: Authentication error',
      '',
    ]) {
      expect({ said, wait: lockedRetryWaitMs(said, 0) }).toEqual({ said, wait: null });
    }
  });
});
