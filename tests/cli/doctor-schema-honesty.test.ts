/**
 * Doctor stops lying about schema state:
 *  - a too-new vault (rollback residue) is a FAIL row naming both versions
 *    and the remediation, not "ok";
 *  - a pending migration is visible on the ok row;
 *  - the daemon's schema-refusal marker surfaces as the Daemon row when
 *    the daemon is down (there is no /health to ask).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkDaemon,
  checkDatabase,
  checkUpdateResidue,
  databaseSchemaStatus,
  schemaRefusalRow,
} from '@myco/cli/doctor.js';
import { writeSchemaRefusalMarker } from '@myco/daemon/schema-refusal.js';
import { resolveDaemonServiceState } from '@myco/daemon/service-state.js';
import { resolveDaemonDataPaths } from '@myco/daemon/data-paths.js';
import { closeDatabase, initDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

let workDir: string;
let savedMycoHome: string | undefined;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-schema-'));
  savedMycoHome = process.env.MYCO_HOME;
});

afterEach(() => {
  closeDatabase();
  clearGroveRegistryCaches();
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Provision a grove-bound vault the way production does (the
 * checkCaptureFlow fixture pattern), pointing MYCO_HOME into the workDir
 * so state/registry/DB all resolve hermetically.
 */
function seedGroveVault(): string {
  const mycoHome = path.join(workDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  process.env.MYCO_HOME = mycoHome;
  const vaultDir = path.join(workDir, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');

  const grove = createGrove('schema-honesty', mycoHome);
  const manifest = ensureProjectManifest(vaultDir, {
    projectName: 'schema-honesty',
    groveId: grove.id,
    groveSlug: grove.slug,
    groveName: grove.name,
  });
  registerProjectInGrove(grove.id, {
    projectId: manifest.project.id,
    projectName: 'schema-honesty',
    projectRoot: workDir,
    bindingId: manifest.grove?.binding_id,
  }, mycoHome);

  const { databasePath } = resolveDaemonDataPaths(vaultDir);
  const db = initDatabase(databasePath);
  createSchema(db);
  closeDatabase();
  return vaultDir;
}

describe('doctor databaseSchemaStatus', () => {
  it('too-new vault → fail row naming both versions and the remediation', () => {
    const { tooNewRow } = databaseSchemaStatus(78, 76);

    expect(tooNewRow?.status).toBe('fail');
    expect(tooNewRow?.name).toBe('Database');
    expect(tooNewRow?.detail).toContain('v78');
    expect(tooNewRow?.detail).toContain('v76');
    expect(tooNewRow?.detail).toContain('myco upgrade');
  });

  it('pending migration → no fail row, pending suffix names both versions', () => {
    const { tooNewRow, pendingSuffix } = databaseSchemaStatus(75, 76);

    expect(tooNewRow).toBeNull();
    expect(pendingSuffix).toContain('v75');
    expect(pendingSuffix).toContain('will update to v76');
  });

  it('current vault → no fail row, no suffix', () => {
    expect(databaseSchemaStatus(76, 76)).toEqual({ tooNewRow: null, pendingSuffix: '' });
  });

  it('unreadable stamp → no fail row, no suffix (never a false alarm)', () => {
    expect(databaseSchemaStatus(null, 76)).toEqual({ tooNewRow: null, pendingSuffix: '' });
  });
});

describe('doctor checkDatabase wiring (behavioral)', () => {
  it('a too-new Grove vault produces the fail row, not "ok"', async () => {
    const vaultDir = seedGroveVault();
    const { databasePath } = resolveDaemonDataPaths(vaultDir);
    const db = initDatabase(databasePath);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(SCHEMA_VERSION + 1, epochSeconds());
    closeDatabase();

    const row = await checkDatabase(vaultDir, testPerUserLockNamespace);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain(`v${SCHEMA_VERSION + 1}`);
    expect(row.detail).toContain('myco upgrade');
  });

  it('a current Grove vault stays ok', async () => {
    const vaultDir = seedGroveVault();
    const row = await checkDatabase(vaultDir, testPerUserLockNamespace);
    expect(row.status).toBe('ok');
  });
});

describe('doctor checkDaemon wiring (behavioral)', () => {
  it('no daemon state + refusal marker → the Daemon row IS the refusal row', async () => {
    const vaultDir = seedGroveVault();
    const { stateDir } = resolveDaemonServiceState(vaultDir, { env: process.env });
    writeSchemaRefusalMarker(stateDir, { found: 80, supported: 76, binary_version: '1.3.0' });

    const row = await checkDaemon(vaultDir);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('refusing to start');
    expect(row.detail).toContain('v80');
  });

  it('stale daemon.json (dead pid) + refusal marker → still the refusal row', async () => {
    const vaultDir = seedGroveVault();
    const { stateDir, statePath } = resolveDaemonServiceState(vaultDir, { env: process.env });
    fs.mkdirSync(stateDir, { recursive: true });
    // A pid that cannot be alive (above macOS/Linux defaults' pid space).
    fs.writeFileSync(statePath, JSON.stringify({ pid: 4_190_000, port: 1 }));
    writeSchemaRefusalMarker(stateDir, { found: 80, supported: 76, binary_version: '1.3.0' });

    const row = await checkDaemon(vaultDir);
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('refusing to start');
  });

  it('no marker → the ordinary not-running row (no false refusals)', async () => {
    const vaultDir = seedGroveVault();
    const row = await checkDaemon(vaultDir);
    expect(row.detail).toContain('Not running');
  });
});

describe('doctor checkUpdateResidue', () => {
  it('surfaces the residue on the default home and stays silent off it', async () => {
    const errorPath = path.join(workDir, 'update-error.json');
    fs.writeFileSync(errorPath, JSON.stringify({ error: 'rollback to 1.2.13 REFUSED (schema gap)' }));
    // The default home is compared as a PATH STRING — no real-home files
    // are read or written; the residue file lives in the temp workDir.
    const realDefaultHome = path.join(os.homedir(), '.myco');

    const offDefault = await checkUpdateResidue(path.join(workDir, 'dogfood-home'), errorPath);
    expect(offDefault).toBeNull();

    const onDefault = await checkUpdateResidue(realDefaultHome, errorPath);
    expect(onDefault?.status).toBe('warn');
    expect(onDefault?.detail).toContain('REFUSED');
  });

  it('null when no residue file exists', async () => {
    const row = await checkUpdateResidue(
      path.join(os.homedir(), '.myco'),
      path.join(workDir, 'missing.json'),
    );
    expect(row).toBeNull();
  });

  it('is wired into the doctor run (a deleted call site fails here)', () => {
    const doctorSrc = fs.readFileSync(
      path.resolve(import.meta.dir, '../../packages/myco/src/cli/doctor.ts'),
      'utf-8',
    );
    const calls = doctorSrc.split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .filter((l) => /await checkUpdateResidue\(\)/.test(l));
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('doctor schemaRefusalRow', () => {
  it('null when no marker exists', async () => {
    expect(await schemaRefusalRow(path.join(workDir, 'state'))).toBeNull();
  });

  it('fail row from the marker: versions, binary, remediation', async () => {
    const stateDir = path.join(workDir, 'state');
    writeSchemaRefusalMarker(stateDir, { found: 80, supported: 76, binary_version: '1.3.0' });

    const row = await schemaRefusalRow(stateDir);
    expect(row?.status).toBe('fail');
    expect(row?.name).toBe('Daemon');
    expect(row?.detail).toContain('v80');
    expect(row?.detail).toContain('v76');
    expect(row?.detail).toContain('1.3.0');
    expect(row?.detail).toContain('myco upgrade');
  });
});
