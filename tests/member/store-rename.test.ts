/**
 * Replacing a member file by rename (`renameReplacing`): on Windows, a rename onto a file another process holds open
 * for a moment (a scanner, the indexer) is refused with EPERM, EACCES or EBUSY, and is tried again before it fails.
 */
import { describe, expect, it } from 'bun:test';
import { renameReplacing } from '@myco/member/store.js';

const refusal = (code: string) => Object.assign(new Error(code), { code });

describe('a rename onto a member file', () => {
  it('is tried again on Windows while the file is held open for a moment, and succeeds', () => {
    let calls = 0;
    const waits: number[] = [];
    renameReplacing('/a.tmp', '/a', {
      platform: 'win32', wait: (ms) => waits.push(ms),
      rename: () => { calls += 1; if (calls < 3) throw refusal(calls === 1 ? 'EPERM' : 'EBUSY'); },
    });
    expect({ calls, waits }).toEqual({ calls: 3, waits: [10, 20] });
  });

  it('fails at once for any other refusal, and anywhere but Windows', () => {
    for (const [platform, code] of [['win32', 'ENOENT'], ['darwin', 'EPERM'], ['linux', 'EBUSY']] as const) {
      let calls = 0;
      expect(() => renameReplacing('/no-such.tmp', '/a', { platform, wait: () => {}, rename: () => { calls += 1; throw refusal(code); } })).toThrow(code);
      expect({ platform, calls }).toEqual({ platform, calls: 1 });
    }
  });

  it('gives up after its retries on Windows, the refusal standing', () => {
    let calls = 0;
    expect(() => renameReplacing('/no-such.tmp', '/a', { platform: 'win32', wait: () => {}, rename: () => { calls += 1; throw refusal('EACCES'); } })).toThrow('EACCES');
    expect(calls).toBe(9);
  });
});
