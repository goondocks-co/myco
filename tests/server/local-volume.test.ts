import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalVolume, volumeIdentity, type VolumeIdentity, type VolumeStartup } from '@myco/server/local-volume.js';
import {
  createLocalDeployment, DEFAULT_LOCAL_RECORD, ensureLocalSecrets, readLocalRecord, removeLocalDeployment,
  resolveLocalPaths, updateLocalDeployment, writeLocalRecord, writeLocalSecrets,
} from '@myco/server/local.js';

type Started = { stop(): Promise<void> };

/** A start that needs no volume mutation: what every caller did before startup joined the lease. */
const serving = (paths: { databasePath: string }, start: () => Promise<Started> = async () => ({ stop: async () => {} })): VolumeStartup<Started> => ({
  pending: () => false,
  startup: () => {},
  identity: () => volumeIdentity(paths.databasePath, () => null),
  start,
});

/** A start whose volume is behind this binary; `startup` is the only thing allowed to change it. */
function migrating(paths: { databasePath: string }, options: { identity?: () => VolumeIdentity; pendingAfter?: boolean } = {}) {
  const plan: VolumeStartup<Started> & { migrations: number; accepted: VolumeIdentity | null } = {
    migrations: 0,
    accepted: null as VolumeIdentity | null,
    pending: () => (options.pendingAfter === true ? true : plan.migrations === 0),
    startup: () => { plan.migrations += 1; },
    identity: options.identity ?? ((): VolumeIdentity => volumeIdentity(paths.databasePath, () => (plan.migrations === 0 ? 'behind' : 'migrated'))),
    start: async (): Promise<Started> => { plan.accepted = plan.identity(); return { stop: async () => {} }; },
  };
  return plan;
}

const volumeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-volume-'));
  const paths = resolveLocalPaths(home);
  writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
  fs.writeFileSync(paths.databasePath, 'preserved fixture bytes');
  return { home, paths };
};

it('refuses every native mutation while the Deployment holds its volume', async () => {
  const { home, paths } = volumeHome();
  const native = { library: null, vec0: null };
  try {
    const running = await new LocalVolume(paths).serve(serving(paths));
    try {
      for (const mutation of [
        () => writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths),
        () => writeLocalSecrets({ SESSION_SECRET: 'replacement' }, paths),
        () => ensureLocalSecrets(paths),
        () => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths),
        () => updateLocalDeployment(native, paths),
        () => removeLocalDeployment(paths),
      ]) expect(mutation).toThrow('volume is in use');
      await expect(new LocalVolume(paths).serve(serving(paths))).rejects.toThrow('already served by another process');
      expect(fs.readFileSync(paths.databasePath, 'utf8')).toBe('preserved fixture bytes');
      expect(readLocalRecord(paths)).toEqual(DEFAULT_LOCAL_RECORD);
      expect(fs.existsSync(paths.secretsFile)).toBe(false);
    } finally { await running.stop(); }
    writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths);
    expect(readLocalRecord(paths).port).toBe(9001);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('releases failed operations and holds an asynchronous publication until it finishes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-volume-'));
  const paths = resolveLocalPaths(home);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    await expect(new LocalVolume(paths).serve(serving(paths, async () => { throw new Error('start failed'); }))).rejects.toThrow('start failed');
    await expect(new LocalVolume(paths).exclusive(async () => { throw new Error('copy failed'); })).rejects.toThrow('copy failed');
    const copying = new LocalVolume(paths).exclusive(() => held);
    expect(() => writeLocalRecord(DEFAULT_LOCAL_RECORD, paths)).toThrow('volume is in use');
    release(); await copying;
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    expect(readLocalRecord(paths)).toEqual(DEFAULT_LOCAL_RECORD);
  } finally { release(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('serves beside an operator backup reading the volume, and refuses every mutation while either holds it', async () => {
  const { home, paths } = volumeHome();
  let finishBackup!: () => void;
  const backing = new Promise<void>((resolve) => { finishBackup = resolve; });
  try {
    const reading = new LocalVolume(paths).reading(() => backing);
    const running = await new LocalVolume(paths).serve(serving(paths));
    expect(() => writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths)).toThrow('volume is in use');
    await running.stop();
    // The backup still holds the volume, so nothing may replace what its snapshot is taken from.
    expect(() => writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths)).toThrow('volume is in use');
    finishBackup();
    await reading;
    writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths);
    expect(readLocalRecord(paths).port).toBe(9001);
  } finally { finishBackup(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('migrates a volume its binary is ahead of under the exclusive lease, and serves what it accepted', async () => {
  const { home, paths } = volumeHome();
  try {
    const plan = migrating(paths);
    const running = await new LocalVolume(paths).serve(plan);
    try {
      expect(plan.migrations).toBe(1);
      expect(plan.accepted).toEqual(plan.identity());
      expect(() => writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths)).toThrow('volume is in use');
    } finally { await running.stop(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses a start that must migrate while a backup holds the volume, and migrates once that backup finishes', async () => {
  const { home, paths } = volumeHome();
  let finishBackup!: () => void;
  const backing = new Promise<void>((resolve) => { finishBackup = resolve; });
  try {
    const reading = new LocalVolume(paths).reading(() => backing);
    const refused = migrating(paths);
    await expect(new LocalVolume(paths).serve(refused)).rejects.toThrow('this start must migrate it');
    expect(refused.migrations).toBe(0);
    finishBackup();
    await reading;
    // The refusal released every lease it took, so the next start is not blocked by it.
    const plan = migrating(paths);
    const running = await new LocalVolume(paths).serve(plan);
    expect(plan.migrations).toBe(1);
    await running.stop();
  } finally { finishBackup(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses a start whose volume changes between its shared and exclusive leases, before any migration', async () => {
  const { home, paths } = volumeHome();
  try {
    // The identity a competing exclusive operation would change in the instant this start holds nothing: the read
    // under the shared lease answers the original volume, the read under the exclusive lease a replacement.
    let reads = 0;
    const plan = migrating(paths, {
      identity: () => { reads += 1; return volumeIdentity(paths.databasePath, () => (reads <= 1 ? 'original' : 'replacement')); },
    });
    await expect(new LocalVolume(paths).serve(plan)).rejects.toThrow('volume changed while this start took its migration lease');
    expect(plan.migrations).toBe(0);
    writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9002 }, paths);
    expect(readLocalRecord(paths).port).toBe(9002);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses a start whose volume changes while it returns to its serving lease, after migrating', async () => {
  const { home, paths } = volumeHome();
  try {
    let reads = 0;
    const plan = migrating(paths, {
      // The reads are: under the shared lease, under the exclusive lease, after the migration, then back under shared.
      identity: () => { reads += 1; return volumeIdentity(paths.databasePath, () => (reads <= 3 ? 'original' : 'replacement')); },
    });
    await expect(new LocalVolume(paths).serve(plan)).rejects.toThrow('volume changed while this start returned to its serving lease');
    expect(plan.migrations).toBe(1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses a volume still behind its binary after its own startup migration', async () => {
  const { home, paths } = volumeHome();
  try {
    const plan = migrating(paths, { pendingAfter: true, identity: () => volumeIdentity(paths.databasePath, () => 'unchanging') });
    await expect(new LocalVolume(paths).serve(plan)).rejects.toThrow('still behind this binary');
    expect(plan.migrations).toBe(3);
    writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9003 }, paths);
    expect(readLocalRecord(paths).port).toBe(9003);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('reads a volume identity from its own database, and answers what it can for a volume that is absent', () => {
  const { home, paths } = volumeHome();
  try {
    const identity = volumeIdentity(paths.databasePath, (key) => (key === 'version' ? '43' : 'dep_1'));
    expect(identity.deploymentId).toBe('dep_1');
    expect(identity.schemaVersion).toBe('43');
    expect(identity.inode).toBeGreaterThan(0);
    expect(volumeIdentity(path.join(home, 'absent.sqlite'), () => null)).toEqual({ deploymentId: null, schemaVersion: null, device: -1, inode: -1 });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
