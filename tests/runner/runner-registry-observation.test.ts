import { afterEach, beforeEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  publishRunnerRecord, readRunnerRecord, recordRunnerContact, runnerRecordPath, withRunnerLock, RUNNER_RECORD_VERSION,
} from '@myco/runner/runner-registry.js';

const SERVER = 'https://runner.example';
const IDENTITY = { runnerId: 'runner-one', deploymentId: 'deployment-one' };
const OFFER = { offered: ['claude-code', 'codex'], withheld: ['cursor'] };
let home: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-observation-'));
  await withRunnerLock(SERVER, lock => publishRunnerRecord(lock, {
    version: RUNNER_RECORD_VERSION, serverUrl: SERVER, deploymentId: IDENTITY.deploymentId,
    runnerId: IDENTITY.runnerId, name: 'mini', token: `mycorun_${'r'.repeat(43)}`,
  }), home);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

it('publishes one changed offer across one hundred identical acknowledged polls', async () => {
  const file = runnerRecordPath(SERVER, home);
  const before = fs.statSync(file).ino;
  let first: number | null = null;
  for (let poll = 0; poll < 100; poll++) {
    expect(await recordRunnerContact(SERVER, IDENTITY, 1_000 + poll * 2_000, home, OFFER)).toBe(true);
    const written = fs.statSync(file).ino;
    if (poll === 0) { expect(written).not.toBe(before); first = written; }
    else expect(written).toBe(first!);
  }
  const observed = readRunnerRecord(SERVER, home)!;
  expect(observed.lastContactAt).toBe(1_000);
  expect(observed.lastOffer).toEqual({ ...OFFER, observedAt: 1_000 });
});

it('refreshes the offer observation on the throttle and writes a changed offer', async () => {
  const file = runnerRecordPath(SERVER, home);
  await recordRunnerContact(SERVER, IDENTITY, 1_000, home, OFFER);
  const first = fs.statSync(file).ino;
  await recordRunnerContact(SERVER, IDENTITY, 2_000, home, OFFER);
  expect(fs.statSync(file).ino).toBe(first);
  await recordRunnerContact(SERVER, IDENTITY, 301_000, home, OFFER);
  expect(fs.statSync(file).ino).not.toBe(first);
  expect(readRunnerRecord(SERVER, home)).toMatchObject({ lastContactAt: 301_000, lastOffer: { ...OFFER, observedAt: 301_000 } });
  await recordRunnerContact(SERVER, IDENTITY, 302_000, home, { offered: ['codex'], withheld: [] });
  expect(readRunnerRecord(SERVER, home)).toMatchObject({ lastContactAt: 302_000, lastOffer: { offered: ['codex'], withheld: [], observedAt: 302_000 } });
});

it('validates identity before a no-op and skips the lock for an unchanged offer', async () => {
  await recordRunnerContact(SERVER, IDENTITY, 1_000, home, OFFER);
  await expect(recordRunnerContact(SERVER, { ...IDENTITY, runnerId: 'another-runner' }, 2_000, home, OFFER)).rejects.toThrow('contact names another runner');
  const result = await withRunnerLock(SERVER, async () => {
    expect(await recordRunnerContact(SERVER, IDENTITY, 2_000, home, OFFER)).toBe(true);
    expect(await recordRunnerContact(SERVER, IDENTITY, 2_000, home, { offered: ['codex'], withheld: [] })).toBe(false);
  }, home);
  expect(result.held).toBe(true);
});
