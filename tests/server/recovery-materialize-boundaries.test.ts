import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { copyRecoveryBundle, verifyRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { materializeRecoveryStaging } from '@myco/server/recovery-materialize.js';
import { backupLocalDeployment } from '@myco/server/local-backup.js';
import { stagingFixture } from './helpers/recovery-staging.js';

const title = (artifact: string): string => {
  const db = new Database(path.join(artifact, 'myco.sqlite'), { readonly: true });
  try { return db.query<{ title: string }, []>("SELECT title FROM sessions WHERE session_id='s_materialize'").get()!.title; } finally { db.close(); }
};

it('refuses staged bytes that do not match the digest the staging records, including a legacy backup', async () => {
  const f = stagingFixture((db) => { db.run('UPDATE backups SET sha256 = NULL'); });
  try {
    const file = path.join(f.staging, 'objects', f.backupKey);
    fs.writeFileSync(file, f.backupBody.replace('backup', 'backuq'));
    expect(fs.statSync(file).size).toBe(f.backupBody.length);
    await expect(f.materialize()).rejects.toThrow(`recovery staging object ${f.backupKey} does not match its recorded fingerprint`);
    expect(fs.existsSync(path.join(f.destination, 'blobs', f.backupKey))).toBe(false);
    fs.writeFileSync(file, f.backupBody);
    const manifest = await f.materialize();
    const copied = manifest.format === 'myco-recovery/2' ? manifest.backupObjects : [];
    expect(copied.map((object) => object.sha256)).toEqual([f.manifest.objects[1]!.sha256]);
  } finally { f.cleanup(); }
});

it('refuses a completed staging whose inventory omits an object digest', async () => {
  const f = stagingFixture();
  try {
    f.write({ ...f.manifest, objects: [f.manifest.objects[0]!, { key: f.backupKey, bytes: f.backupBody.length }] });
    await expect(f.materialize()).rejects.toThrow();
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses a different snapshot of the same Deployment into a destination, and resumes an identical retry', async () => {
  const f = stagingFixture();
  try {
    expect((await f.materialize()).status).toBe('complete');
    expect((await f.materialize()).status).toBe('complete');
    expect(title(f.destination)).toBe('Recovered 🌱 title');

    const sql = path.join(f.staging, 'd1.sql');
    fs.writeFileSync(sql, fs.readFileSync(sql, 'utf8').replace('Recovered 🌱 title', 'Fresh new title'));
    f.write({ ...f.manifest, database: f.fingerprint(sql) });
    await expect(f.materialize()).rejects.toThrow('holds a different snapshot of this Deployment');
    expect(title(f.destination)).toBe('Recovered 🌱 title');

    // The same refusal protects a destination an interrupted materialization left behind.
    const second = stagingFixture();
    try {
      fs.mkdirSync(second.destination, { recursive: true });
      fs.writeFileSync(path.join(second.destination, 'recovery.json'), fs.readFileSync(path.join(f.destination, 'recovery.json')));
      await expect(second.materialize()).rejects.toThrow('holds a different snapshot of this Deployment');
    } finally { second.cleanup(); }
  } finally { f.cleanup(); }
});

it('binds the artifact to the configuration and inventory the staging recorded', async () => {
  for (const change of [
    (manifest: Record<string, unknown>) => ({ ...manifest, configuration: { accountId: 'other-account' } }),
    (manifest: Record<string, unknown>) => ({ ...manifest, credentialsRequired: ['OTHER_KEY'] }),
    (manifest: Record<string, unknown>) => ({ ...manifest, exportBookmark: 'a-later-bookmark' }),
  ]) {
    const f = stagingFixture();
    try {
      expect((await f.materialize()).status).toBe('complete');
      f.write(change(f.manifest as unknown as Record<string, unknown>));
      await expect(f.materialize()).rejects.toThrow('holds a different snapshot of this Deployment');
    } finally { f.cleanup(); }
  }
});

it('consumes only bytes it has held to a digest when the staging changes mid-materialization', async () => {
  const f = stagingFixture();
  try {
    const sql = path.join(f.staging, 'd1.sql');
    const manifest = await materializeRecoveryStaging({
      staging: f.staging,
      destination: f.destination,
      report: (line) => {
        if (line === 'Reconstructing the snapshot from the staged export') {
          fs.writeFileSync(sql, fs.readFileSync(sql, 'utf8').replace('Recovered 🌱 title', 'Changed after hash'));
        }
      },
    });
    expect(manifest.status).toBe('complete');
    expect(title(f.destination)).toBe('Recovered 🌱 title');
  } finally { f.cleanup(); }
});

it('refuses an inventory entry the snapshot does not register', async () => {
  const f = stagingFixture();
  try {
    f.write({ ...f.manifest, objects: [...f.manifest.objects, { key: 'unrelated/not-a-digest', sha256: 'a'.repeat(64), bytes: 123 }] });
    await expect(f.materialize()).rejects.toThrow('1 unregistered');
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses a staged path whose parent directory is a symlink, and a destination aliased through one', async () => {
  const f = stagingFixture();
  try {
    const objects = path.join(f.staging, 'objects', 'proj_1');
    const outside = path.join(f.root, 'outside');
    fs.renameSync(objects, outside);
    fs.symlinkSync(outside, objects);
    await expect(f.materialize()).rejects.toThrow('leaves the staging');
    fs.rmSync(objects);
    fs.renameSync(outside, objects);

    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.staging, alias);
    await expect(materializeRecoveryStaging({ staging: f.staging, destination: path.join(alias, 'inside') }))
      .rejects.toThrow('must not overlap');
  } finally { f.cleanup(); }
});

it('carries the receipt through verification and copies, and leaves receipt-free artifacts alone', async () => {
  const f = stagingFixture();
  try {
    const materialized = await f.materialize();
    expect(materialized.source.receipt).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyRecoveryBundle(f.destination)).source.receipt).toBe(materialized.source.receipt);
    const copy = path.join(f.root, 'copy');
    expect((await copyRecoveryBundle(f.destination, copy)).source.receipt).toBe(materialized.source.receipt);
    expect((await verifyRecoveryBundle(copy)).status).toBe('complete');
    // A second copy into the same destination is the identical retry the owner already resumes.
    expect((await copyRecoveryBundle(f.destination, copy)).status).toBe('complete');

    // A native artifact names no staged snapshot, and stays verifiable and copyable.
    const volume = path.join(f.root, 'server', 'local');
    fs.mkdirSync(path.join(volume, 'blobs', 'proj_1'), { recursive: true });
    fs.mkdirSync(path.join(volume, 'blobs', 'backups'), { recursive: true });
    fs.writeFileSync(path.join(volume, 'blobs', 'proj_1', f.blobDigest), f.bytes);
    fs.writeFileSync(path.join(volume, 'blobs', f.backupKey), f.backupBody);
    const databasePath = path.join(volume, 'myco.sqlite');
    f.source.sqlite.exec(`VACUUM INTO '${databasePath}'`);
    fs.writeFileSync(path.join(volume, 'server.json'), JSON.stringify({ port: 8787, origin: 'http://127.0.0.1:8787', fleet: 'local' }));
    const paths = { root: volume, recordFile: path.join(volume, 'server.json'), databasePath, blobDir: path.join(volume, 'blobs'), secretsFile: path.join(volume, 'secrets.env') };
    const native = path.join(f.root, 'native');
    const captured = await backupLocalDeployment({ paths, destination: native });
    expect(captured.source.receipt).toBeUndefined();
    expect((await verifyRecoveryBundle(native)).status).toBe('complete');
    expect((await copyRecoveryBundle(native, path.join(f.root, 'native-copy'))).status).toBe('complete');
  } finally { f.cleanup(); }
});
