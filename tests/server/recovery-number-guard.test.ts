import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupLocalDeployment } from '@myco/server/local-backup.js';
import { copyRecoveryBundle, verifyRecoveryBundle } from '@myco/server/recovery-bundle.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

/**
 * A locally served Deployment's own volume, snapshotted by the native backup owner: no provider export is involved, so
 * the refusal's wording is checked on the target where a rounded export never happened.
 */
function fixture(plant: (db: Database) => void) {
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-number-guard-'));
  const volume = path.join(root, 'server', 'local');
  fs.mkdirSync(path.join(volume, 'blobs'), { recursive: true });
  source.sqlite.exec('CREATE TABLE guard_fixture(id TEXT PRIMARY KEY, counted INTEGER, measured REAL)');
  plant(source.sqlite);
  const databasePath = path.join(volume, 'myco.sqlite');
  source.sqlite.exec(`VACUUM INTO '${databasePath}'`);
  source.sqlite.close();
  const paths = {
    root: volume, recordFile: path.join(volume, 'server.json'), databasePath,
    blobDir: path.join(volume, 'blobs'), secretsFile: path.join(volume, 'secrets.env'),
  };
  fs.writeFileSync(paths.recordFile, JSON.stringify({ port: 8787, origin: 'http://127.0.0.1:8787', fleet: 'local' }));
  const destination = path.join(root, 'artifact');
  return {
    root, destination,
    backup: () => backupLocalDeployment({ paths, destination }),
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

it('captures a snapshot whose numbers stay inside the contract', async () => {
  const f = fixture((db) => {
    db.run("INSERT INTO guard_fixture VALUES ('safe', 9007199254740991, 1.5)");
    db.run("INSERT INTO guard_fixture VALUES ('negative', -9007199254740991, -0.25)");
  });
  try {
    expect((await f.backup()).status).toBe('complete');
    expect((await verifyRecoveryBundle(f.destination)).status).toBe('complete');
  } finally { f.cleanup(); }
});

it('refuses an integer at the safe boundary and reports the column with its row count', async () => {
  const f = fixture((db) => {
    db.run("INSERT INTO guard_fixture VALUES ('high', 9223372036854775807, NULL)");
    db.run("INSERT INTO guard_fixture VALUES ('boundary', 9007199254740992, NULL)");
    db.run("INSERT INTO guard_fixture VALUES ('low', -9007199254740992, NULL)");
    db.run("INSERT INTO guard_fixture VALUES ('safe', 5, NULL)");
  });
  try {
    await expect(f.backup()).rejects.toThrow('guard_fixture.counted (3 rows)');
    // The wording states the contract and the provider limit without claiming a provider export ran here.
    await expect(f.backup()).rejects.toThrow('Investigate and correct these values at their source deliberately');
    await expect(f.backup()).rejects.toThrow('capturing the snapshot again leaves them unchanged');
    const message = await f.backup().catch((error: Error) => error.message);
    expect(message).not.toContain('D1');
    expect(message).not.toContain('retry');
    expect(fs.existsSync(path.join(f.destination, 'myco.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});

it('refuses a REAL stored in an INTEGER-affinity column and counts both rules together', async () => {
  const f = fixture((db) => {
    // The shape a provider export leaves behind when it cannot carry an integer: a REAL in an integer column.
    db.run("INSERT INTO guard_fixture VALUES ('rounded', 9.223372036854776e+18, 2.5)");
    db.run("INSERT INTO guard_fixture VALUES ('also-rounded', 1.0e+19, NULL)");
    db.run("INSERT INTO guard_fixture VALUES ('unsafe-integer', -9007199254740992, NULL)");
  });
  try {
    const message = await f.backup().catch((error: Error) => error.message);
    expect(message).toContain('guard_fixture.counted (3 rows)');
    expect(message).not.toContain('guard_fixture.measured');
  } finally { f.cleanup(); }
});

it('refuses a verification and a copy of an artifact captured before this guard existed', async () => {
  const f = fixture((db) => { db.run("INSERT INTO guard_fixture VALUES ('safe', 5, 1.5)"); });
  try {
    await expect(f.backup()).resolves.toBeDefined();
    // An artifact whose own manifest describes such a database: the state an earlier capture could leave behind.
    const file = path.join(f.destination, 'myco.sqlite');
    const database = new Database(file);
    try { database.run("INSERT INTO guard_fixture VALUES ('planted', 9223372036854775807, NULL)"); } finally { database.close(); }
    const manifestFile = path.join(f.destination, 'recovery.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.snapshot.database = { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    await expect(verifyRecoveryBundle(f.destination)).rejects.toThrow('guard_fixture.counted (1 row)');
    await expect(copyRecoveryBundle(f.destination, path.join(f.root, 'copy'))).rejects.toThrow('guard_fixture.counted (1 row)');
  } finally { f.cleanup(); }
});
