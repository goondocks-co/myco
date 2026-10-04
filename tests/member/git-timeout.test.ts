import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __resetGitBinaryCacheForTest, gitExitStatus, gitExitStatusAsync, runGit } from '@myco/utils/git.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';

describe('Git query deadlines', () => {
  it('lets unbudgeted callers finish slow Git and expires explicitly budgeted queries', async () => {
    if (process.platform === 'win32') return;
    const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-git-timeout-')));
    const bin = path.join(root, 'git');
    fs.writeFileSync(bin, '#!/bin/sh\n/bin/sleep 1.2\nprintf "answer\\n"\n', { mode: 0o700 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ''}`;
    __resetGitBinaryCacheForTest();
    try {
      expect(runGit(['fake-query'], root)).toBe('answer');
      expect(gitExitStatus(['fake-query'], root)).toBe(0);
      expect(await gitExitStatusAsync(['fake-query'], root)).toBe(0);
      expect(() => runGit(['fake-query'], root, { deadline: Date.now() + 20 })).toThrow();
      expect(gitExitStatus(['fake-query'], root, { deadline: Date.now() + 20 })).toBeNull();
      expect(gitExitStatus(['fake-query'], root, { deadline: Date.now() - 1 })).toBeNull();
      expect(await gitExitStatusAsync(['fake-query'], root, { deadline: Date.now() + 20 })).toBeNull();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      __resetGitBinaryCacheForTest();
    }
  });
});
