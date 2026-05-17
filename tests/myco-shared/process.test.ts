import { describe, it, expect, spyOn } from 'bun:test';
import { isProcessAlive } from '@goondocks/myco-shared';

/**
 * `isProcessAlive` is the load-bearing primitive behind the
 * reconcileExistingDaemon polling ladder. The ladder decides whether to
 * unlink daemon.json based on this function's return value. Conflating the
 * three `process.kill(pid, 0)` outcomes is a self-mutation-discipline tenet
 * violation:
 *
 *   - succeeds        → ALIVE
 *   - throws ESRCH    → DEAD
 *   - throws EPERM    → ALIVE (process exists, caller can't signal it)
 *   - any other error → ALIVE (conservative; err away from orphaning state)
 */
describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false when process.kill throws ESRCH (process genuinely dead)', () => {
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      expect(isProcessAlive(99999)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns true when process.kill throws EPERM (process exists but inaccessible)', () => {
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      expect(isProcessAlive(99999)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns true for any unexpected error (conservative)', () => {
    const spy = spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('something unexpected');
    });
    try {
      expect(isProcessAlive(99999)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
