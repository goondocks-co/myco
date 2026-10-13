/**
 * One rule for a path inside a compiled binary's own filesystem (`runtime/self-exec.ts` `isBundledPath`), read by every
 * caller that must tell such a path from a file on disk. A Windows build names its entry with forward slashes
 * (`B:/~BUN/root/<exe>`, observed on Bun 1.3.13); a caller with its own copy of the prefixes missed that form.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { selfExec } from '@myco/runtime/self-exec.js';

const BUNDLED_ROOTS = ['/$bunfs/root', 'B:\\~BUN\\root', 'B:/~BUN/root'];
const savedArgv1 = process.argv[1];
afterEach(() => { process.argv[1] = savedArgv1; });

describe('a path inside a compiled binary', () => {

  it('is no entry script for a helper\'s start (a project\'s, or the join bucket\'s), in every form a build reports', () => {
    for (const root of BUNDLED_ROOTS) {
      process.argv[1] = `${root}/myco.exe`;
      expect(selfExec()).toEqual({ path: process.execPath, args: [] });
    }
  });
});
