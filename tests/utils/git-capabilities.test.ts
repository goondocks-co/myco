import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { supportsGitReftable } from '../helpers/git-capabilities.ts';

test('probes reftable support without opening browser help and removes either result', () => {
  for (const status of [0, 129]) {
    let probe = '';
    const supported = supportsGitReftable((args) => {
      if (args.includes('--help')) throw new Error('Git browser help must never be opened by a test');
      expect(args).toContain('--ref-format=reftable');
      probe = args.at(-1)!;
      expect(fs.statSync(probe).isDirectory()).toBe(true);
      return { status };
    });
    expect(supported).toBe(status === 0);
    expect(fs.existsSync(probe)).toBe(false);
  }
});

test('surfaces a failed Git start and removes its probe', () => {
  let probe = '';
  expect(() => supportsGitReftable((args) => {
    probe = args.at(-1)!;
    return { status: null, error: new Error('Git could not start') };
  })).toThrow('Git could not start');
  expect(fs.existsSync(probe)).toBe(false);
});
