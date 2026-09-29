/**
 * A reader of the member registry that lands in the middle of a write sees the
 * entry as it was before the write or as it is after, never neither.
 *
 * Every registry writer — join and bind (`writeRegistryEntry`), rotation and
 * the refusal marks renewal records (`writeDeploymentMembership`), the v1
 * upgrade (`migrateRegistry`) and leave (`removeRegistryEntry`) — is paused at
 * each filesystem step it takes: with a temporary file half written, before and
 * after each rename, and before and after each delete. At every pause both
 * readers run: the report read (`readRegistryEntryResult`, which the member
 * verbs use) and the hook read (`readRegistryEntry`, which capture uses).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  deploymentPath, migrateRegistry, projectsDir, readRegistryEntry, readRegistryEntryResult, registryEntryPath, removeRegistryEntry,
  writeDeploymentMembership, writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry,
} from '@myco/member/registry.js';
import { ensureMemberDir } from '@myco/member/store.js';
import { tempMycoHome } from './helpers/server.js';

const SERVER_URL = 'https://s.example';
let mycoHome: string;
let root: string;
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  mycoHome = tempMycoHome();
  root = path.join(mycoHome, 'repo');
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const entry = (over: Partial<RegistryEntry> = {}): RegistryEntry => ({
  version: REGISTRY_VERSION, projectId: 'proj_1', serverUrl: SERVER_URL, token: 'tok_a', tokenId: 'mt_a', root, machineId: 'm1', joinedAt: 1, updatedAt: 1, ...over,
});

/** What one reader saw at one pause: absent, or the fields that tell the before and after entries apart. */
type Seen = 'missing' | 'unavailable' | { token: string; projectId: string; refusedAt: number | null | undefined; nonRotating: boolean | undefined };

const seenOf = (e: RegistryEntry): Seen => ({ token: e.token, projectId: e.projectId, refusedAt: e.refusedAt, nonRotating: e.nonRotating });

/** Both readers, as they stand now. */
function readBoth(): Seen[] {
  const report = readRegistryEntryResult(root, mycoHome);
  const hook = readRegistryEntry(root, mycoHome);
  return [report.status === 'present' ? seenOf(report.entry) : report.status, hook === null ? 'missing' : seenOf(hook)];
}

/**
 * Run `write` with every file step it takes paused for both readers, and
 * return what they saw and how many pauses there were. The readers run between
 * the step's halves, so what they see is the store with the step partly done.
 */
function readDuring(write: () => void): { seen: Seen[]; pauses: number } {
  const seen: Seen[] = [];
  let pauses = 0;
  const pause = (): void => { pauses += 1; seen.push(...readBoth()); };
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;
  const realRm = fs.rmSync;
  const spies = [
    spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, opts?: fs.WriteFileOptions) => {
      if (typeof file === 'string' && file.endsWith('.tmp') && typeof data === 'string') {
        realWrite(file, data.slice(0, Math.floor(data.length / 2)), opts);
        pause();
      }
      realWrite(file, data, opts);
    }) as typeof fs.writeFileSync),
    spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      pause();
      realRename(from, to);
      pause();
    }) as typeof fs.renameSync),
    spyOn(fs, 'unlinkSync').mockImplementation(((file: fs.PathLike) => {
      pause();
      realUnlink(file);
      pause();
    }) as typeof fs.unlinkSync),
    spyOn(fs, 'rmSync').mockImplementation(((file: fs.PathLike, opts?: fs.RmOptions) => {
      pause();
      realRm(file, opts);
      pause();
    }) as typeof fs.rmSync),
  ];
  try {
    write();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return { seen, pauses };
}

/** Every observation is one of `allowed`, and each of the before and after states was seen at least once. */
function expectOnlyBeforeOrAfter(run: { seen: Seen[]; pauses: number }, before: Seen, after: Seen): void {
  expect(run.pauses).toBeGreaterThan(0);
  const key = (s: Seen): string => JSON.stringify(s);
  const allowed = new Set([key(before), key(after)]);
  expect(run.seen.map(key).filter((s) => !allowed.has(s))).toEqual([]);
  expect(run.seen.map(key)).toContain(key(before));
  expect(run.seen.map(key)).toContain(key(after));
  expect(stderrLines.join('')).not.toMatch(/registry entry skipped|deployment membership skipped/);
}

describe('a registry reader during a registry write', () => {
  it('sees no membership or the joined one while a machine joins', () => {
    const run = readDuring(() => writeRegistryEntry(entry(), { mycoHome }));
    expectOnlyBeforeOrAfter(run, 'missing', seenOf(entry()));
  });

  it('sees the predecessor or the successor while a rotation writes the successor', () => {
    writeRegistryEntry(entry(), { mycoHome });
    const run = readDuring(() => writeDeploymentMembership({ serverUrl: SERVER_URL, token: 'tok_b', tokenId: 'mt_b', machineId: 'm1', joinedAt: 1, updatedAt: 2 }, { mycoHome }));
    expectOnlyBeforeOrAfter(run, seenOf(entry()), seenOf(entry({ token: 'tok_b' })));
  });

  it('sees the entry before or after renewal records a non-rotating token and its refusal', () => {
    writeRegistryEntry(entry(), { mycoHome });
    const nonRotating = readDuring(() => writeDeploymentMembership({ serverUrl: SERVER_URL, token: 'tok_a', nonRotating: true, machineId: 'm1', joinedAt: 1, updatedAt: 2 }, { mycoHome }));
    expectOnlyBeforeOrAfter(nonRotating, seenOf(entry()), seenOf(entry({ nonRotating: true })));
    const refused = readDuring(() => writeDeploymentMembership({ serverUrl: SERVER_URL, token: 'tok_a', refusedAt: 5, machineId: 'm1', joinedAt: 1, updatedAt: 3 }, { mycoHome }));
    expectOnlyBeforeOrAfter(refused, seenOf(entry({ nonRotating: true })), seenOf(entry({ nonRotating: true, refusedAt: 5 })));
  });

  it('sees the old Project or the new one while a root is bound again', () => {
    writeRegistryEntry(entry(), { mycoHome });
    const run = readDuring(() => writeRegistryEntry(entry({ projectId: 'proj_2', updatedAt: 2 }), { mycoHome }));
    expectOnlyBeforeOrAfter(run, seenOf(entry()), seenOf(entry({ projectId: 'proj_2' })));
  });

  it('sees the membership or none while the machine leaves', () => {
    writeRegistryEntry(entry(), { mycoHome });
    const run = readDuring(() => { removeRegistryEntry(root, mycoHome); });
    expectOnlyBeforeOrAfter(run, seenOf(entry()), 'missing');
    expect(fs.existsSync(deploymentPath(SERVER_URL, mycoHome))).toBe(false);
  });

  it('sees the v1 entry or its upgrade, never neither, while the registry is upgraded', () => {
    ensureMemberDir(projectsDir(mycoHome), mycoHome);
    fs.writeFileSync(registryEntryPath(root, mycoHome), `${JSON.stringify({ ...entry(), version: 1 }, null, 2)}\n`, { mode: 0o600 });
    const seen: Seen[] = [];
    let pauses = 0;
    const realRename = fs.renameSync;
    const spy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      for (const at of [0, 1]) {
        if (at === 1) realRename(from, to);
        pauses += 1;
        const report = readRegistryEntryResult(root, mycoHome);
        seen.push(report.status === 'present' ? seenOf(report.entry) : report.status);
      }
    }) as typeof fs.renameSync);
    try {
      expect(migrateRegistry(mycoHome)).toEqual({ upgraded: 1, consolidated: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(pauses).toBeGreaterThan(0);
    expect(seen).toEqual(Array(pauses).fill(seenOf(entry())));
    expect(JSON.parse(fs.readFileSync(registryEntryPath(root, mycoHome), 'utf-8')).version).toBe(REGISTRY_VERSION);
  });
});
