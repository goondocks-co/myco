import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalVolume } from '@myco/server/local-volume.js';
import {
  createLocalDeployment, DEFAULT_LOCAL_RECORD, ensureLocalSecrets, readLocalRecord, removeLocalDeployment,
  resolveLocalPaths, updateLocalDeployment, writeLocalRecord, writeLocalSecrets,
} from '@myco/server/local.js';

it('refuses every native mutation while the Deployment holds its volume', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-volume-'));
  const paths = resolveLocalPaths(home);
  const native = { library: null, vec0: null };
  try {
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    fs.writeFileSync(paths.databasePath, 'preserved fixture bytes');
    const running = await new LocalVolume(paths).serve(async () => ({ stop: async () => {} }));
    try {
      for (const mutation of [
        () => writeLocalRecord({ ...DEFAULT_LOCAL_RECORD, port: 9001 }, paths),
        () => writeLocalSecrets({ SESSION_SECRET: 'replacement' }, paths),
        () => ensureLocalSecrets(paths),
        () => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths),
        () => updateLocalDeployment(native, paths),
        () => removeLocalDeployment(paths),
      ]) expect(mutation).toThrow('volume is in use');
      await expect(new LocalVolume(paths).serve(async () => ({ stop: async () => {} }))).rejects.toThrow('volume is in use');
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
    await expect(new LocalVolume(paths).serve(async () => { throw new Error('start failed'); })).rejects.toThrow('start failed');
    await expect(new LocalVolume(paths).exclusive(async () => { throw new Error('copy failed'); })).rejects.toThrow('copy failed');
    const copying = new LocalVolume(paths).exclusive(() => held);
    expect(() => writeLocalRecord(DEFAULT_LOCAL_RECORD, paths)).toThrow('volume is in use');
    release(); await copying;
    writeLocalRecord(DEFAULT_LOCAL_RECORD, paths);
    expect(readLocalRecord(paths)).toEqual(DEFAULT_LOCAL_RECORD);
  } finally { release(); fs.rmSync(home, { recursive: true, force: true }); }
});
