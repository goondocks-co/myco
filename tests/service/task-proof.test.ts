import { expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishTaskProof, readTaskProof, waitForTaskProof, type TaskSnapshot } from '../helpers/task-proof.js';
import { renameBusy, renameBusySync } from '../helpers/rename-busy.js';

const state = (state: string, lastRunTime = 'old', lastTaskResult = 0): TaskSnapshot => ({ state, lastRunTime, lastTaskResult });

it('waits for a fresh running task through a busy runner queue before reading proof', async () => {
  let now = 0;
  let reads = 0;
  const states = [state('Ready'), state('Queued'), state('Running', 'old'), state('Running', 'new', 267009)];
  const result = await waitForTaskProof(async () => states.shift()!, () => { reads++; return { pid: 42 }; }, 'old', {
    now: () => now, pause: async () => { now += 20_000; }, timeoutMs: 80_000,
  });
  expect(result).toEqual({ pid: 42 });
  expect(reads).toBe(1);
  expect(now).toBe(60_000);
});

it('reports the last task state and result on a bounded timeout and a failed attempt', async () => {
  let now = 0;
  await expect(waitForTaskProof(async () => state('Queued', 'old', 267011), () => undefined, 'old', {
    now: () => now, pause: async () => { now += 100; }, timeoutMs: 200,
  })).rejects.toThrow('"state":"Queued","lastRunTime":"old","lastTaskResult":267011');
  await expect(waitForTaskProof(async () => state('Ready', 'new', 2147942402), () => undefined, 'old'))
    .rejects.toThrow('"state":"Ready","lastRunTime":"new","lastTaskResult":2147942402');
});

it('polls again when reading proof encounters a transient Windows lock', async () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const spy = spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('proof held'), { code });
    }).mockReturnValueOnce('{"pid":42}');
    let pauses = 0;
    try {
      expect(await waitForTaskProof(async () => state('Running', 'new'), () => readTaskProof<{ pid: number }>('proof'), 'old', {
        pause: async () => { pauses++; },
      })).toEqual({ pid: 42 });
      expect(pauses).toBe(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  }
});

it('publishes proof after a transient Windows rename lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-task-proof-'));
  const file = path.join(root, 'task-proof.json');
  const rename = fs.renameSync;
  const spy = spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw Object.assign(new Error('proof held'), { code: 'EBUSY' });
  }).mockImplementation(rename);
  try {
    publishTaskProof(file, { pid: 42 });
    expect(readTaskProof<{ pid: number }>(file)).toEqual({ pid: 42 });
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('bounds synchronous rename retries and retains the original lock error', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const original = Object.assign(new Error('proof held'), { code });
    let now = 0;
    let attempts = 0;
    expect(() => renameBusySync('a', 'b', {
      rename: () => { throw ++attempts === 1 ? original : Object.assign(new Error('still held'), { code }); },
      now: () => now, pause: () => { now += 5_000; },
    })).toThrow(original);
    expect(now).toBe(5_000);
    expect(attempts).toBe(2);
  }
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  expect(() => renameBusySync('a', 'b', { rename: () => { throw missing; } })).toThrow(missing);
});

it('publishes a complete proof by rename and waits through an incomplete document', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-task-proof-'));
  const file = path.join(root, 'task-proof.json');
  const write = fs.writeFileSync;
  const spy = spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
    expect(target).not.toBe(file);
    write(target, '{', options);
    expect(fs.existsSync(file)).toBe(false);
    write(target, data, options);
  });
  try {
    publishTaskProof(file, { pid: 42 });
    expect(readTaskProof<{ pid: number }>(file)).toEqual({ pid: 42 });
    spy.mockRestore();
    fs.writeFileSync(file, '{');
    let polls = 0;
    expect(await waitForTaskProof(async () => state('Running', 'new', 267009), () => readTaskProof<{ pid: number }>(file), 'old', {
      pause: async () => { polls++; publishTaskProof(file, { pid: 43 }); },
    })).toEqual({ pid: 43 });
    expect(polls).toBe(1);
    expect(readTaskProof(path.join(root, 'absent'))).toBeUndefined();
  } finally { spy.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('retries a transient image-handle lock but propagates other errors and bounds a persistent lock', async () => {
  let attempts = 0;
  const busy = Object.assign(new Error('image held'), { code: 'EBUSY' });
  await renameBusy('a', 'b', { rename: () => { if (++attempts < 3) throw busy; }, pause: async () => {} });
  expect(attempts).toBe(3);
  const denied = Object.assign(new Error('missing'), { code: 'ENOENT' });
  await expect(renameBusy('a', 'b', { rename: () => { throw denied; } })).rejects.toBe(denied);
  let now = 0;
  await expect(renameBusy('a', 'b', { rename: () => { throw busy; }, now: () => now, pause: async () => { now += 5_000; } })).rejects.toBe(busy);
  expect(now).toBe(5_000);
});
