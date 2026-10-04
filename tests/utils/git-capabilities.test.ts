import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { supportsGitReftable } from '../helpers/git-capabilities.ts';

test('probes reftable support without opening browser help and removes either result', () => {
  for (const result of [
    { status: 0, stderr: '' },
    { status: 129, stderr: "error: unknown option `ref-format=reftable'\nusage: git init" },
    { status: 128, stderr: "fatal: unknown ref storage format 'reftable'\n" },
  ]) {
    let probe = '';
    const supported = supportsGitReftable((args) => {
      if (args.includes('--help')) throw new Error('Git browser help must never be opened by a test');
      expect(args).toContain('--ref-format=reftable');
      probe = args.at(-1)!;
      expect(fs.statSync(probe).isDirectory()).toBe(true);
      return result;
    });
    expect(supported).toBe(result.status === 0);
    expect(fs.existsSync(probe)).toBe(false);
  }
});

test('surfaces unexpected Git failures instead of dropping reftable coverage and removes its probe', () => {
  for (const result of [
    { status: 128, stderr: 'fatal: cannot mkdir: Permission denied' },
    { status: 129, stderr: 'error: unknown option: unrelated' },
    { status: null, signal: 'SIGTERM', stderr: '' },
  ]) {
    let probe = '';
    expect(() => supportsGitReftable((args) => {
      probe = args.at(-1)!;
      return result;
    })).toThrow('Git reftable probe failed');
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
