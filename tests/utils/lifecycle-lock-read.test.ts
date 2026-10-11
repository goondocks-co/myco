import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifecycleLock, withFileLockSync } from '@myco/utils/lifecycle-lock.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-read-lock-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('an absent no-create lock is readable only with the explicit read fallback', () => {
  const lock = path.join(root, 'missing', 'read.lock');
  expect(() => LifecycleLock.acquire(lock, { mode: 'shared', create: false })).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  expect(() => withFileLockSync(lock, () => 'read', { create: false })).toThrow();
  expect(withFileLockSync(lock, () => 'read', { create: false, readIfMissing: true })).toBe('read');
  expect(fs.readdirSync(root)).toEqual([]);
});

it('the read fallback propagates callback failures without retrying', () => {
  const lock = path.join(root, 'read.lock');
  fs.writeFileSync(lock, '');
  let calls = 0;
  const error = Object.assign(new Error('journal missing'), { code: 'ENOENT' });
  expect(() => withFileLockSync(lock, () => { calls++; throw error; }, { create: false, readIfMissing: true })).toThrow(error);
  expect(calls).toBe(1);
  fs.unlinkSync(lock);
  expect(() => withFileLockSync(lock, () => { calls++; throw error; }, { create: false, readIfMissing: true })).toThrow(error);
  expect(calls).toBe(2);
});
