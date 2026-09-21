/**
 * Store maintenance: the native port against a real volume, the claim and cadence every run goes through, and
 * the hosted target's named limit failures.
 *
 * The native checks run over a file on disk, because the integrity check reads it from a thread of its own; what
 * they find is SQLite's own answer for a store this test damaged, never a stand-in.
 */
import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateAndSeed } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { sqliteStoreMaintenance, checkIntegrityOffThread } from '@myco-server-worker/platform/bun/store-maintenance.js';
import { classifyD1Error } from '@myco-server-worker/platform/cloudflare/env.js';
import {
  cadenceOf, latestOutcome, maintenanceDue, runMaintenance, type MaintenanceCheck, type PortResult, type StoreMaintenancePort,
} from '@myco-server-worker/core/store-maintenance.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';

const HOUR = 3_600_000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A migrated Deployment database in a file of its own, in WAL mode as the self-hosted target opens it. */
function volume(): { sqlite: Database; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-maintenance-'));
  dirs.push(dir);
  const file = path.join(dir, 'myco.db');
  const sqlite = new Database(file, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL');
  migrateAndSeed(sqlite);
  return { sqlite, file };
}

it('native optimize and integrity on a clean volume answer no findings and a measured size', async () => {
  const { sqlite } = volume();
  const port = sqliteStoreMaintenance(sqlite);
  const optimized = await port.run('optimize');
  expect(optimized.findings).toEqual([]);
  expect(optimized.measurements.find((m) => m.name === 'size')).toMatchObject({ state: 'measured', unit: 'bytes' });
  const checked = await port.run('integrity');
  expect(checked).toMatchObject({ findings: [] });
  expect(checked.incomplete).toBeUndefined();
});

it('native integrity reports a dangling foreign key and a damaged index in SQLite\'s own words', async () => {
  const { sqlite, file } = volume();
  sqlite.exec('CREATE TABLE maint_parent (id INTEGER PRIMARY KEY)');
  sqlite.exec('CREATE TABLE maint_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES maint_parent(id), label TEXT)');
  sqlite.exec('CREATE INDEX maint_child_label ON maint_child (label)');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  sqlite.exec(`INSERT INTO maint_child (parent, label) VALUES (99, 'label-original'), (NULL, 'label-other')`);
  sqlite.exec('PRAGMA foreign_keys = ON');
  // Rewrite the index's stored key on disk, so the entry no longer matches the row it indexes.
  const { rootpage } = sqlite.query(`SELECT rootpage FROM sqlite_schema WHERE name = 'maint_child_label'`).get() as { rootpage: number };
  const pageSize = (sqlite.query('PRAGMA page_size').get() as { page_size: number }).page_size;
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  sqlite.close();
  const bytes = fs.readFileSync(file);
  const page = bytes.subarray((rootpage - 1) * pageSize, rootpage * pageSize);
  const at = page.indexOf('label-original');
  expect(at).toBeGreaterThan(0);
  page.write('label-damaged!', at);
  fs.writeFileSync(file, bytes);
  const reopened = new Database(file, { readwrite: true });
  const result = await sqliteStoreMaintenance(reopened).run('integrity');
  reopened.close();
  expect(result.findings.some((f) => f.startsWith('maint_child:'))).toBe(true);
  expect(result.findings).toContain('foreign key: maint_child row 1 names a missing maint_parent');
});

it('a native check past its deadline stops between tables and says how far it got', async () => {
  const { file } = volume();
  const report = await checkIntegrityOffThread(file, { deadlineMs: 0 });
  expect(report.stoppedAtDeadline).toBe(true);
  expect(report.tablesChecked).toBe(0);
  expect(report.tablesTotal).toBeGreaterThan(10);
});

it('capture keeps committing while the native integrity check reads', async () => {
  const { sqlite, file } = volume();
  sqlite.exec('CREATE TABLE maint_load (id INTEGER PRIMARY KEY, a TEXT)');
  sqlite.exec(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 200000) INSERT INTO maint_load (a) SELECT hex(randomblob(16)) FROM c`);
  sqlite.exec('CREATE INDEX maint_load_a ON maint_load (a)');
  let done = false;
  let writes = 0;
  const check = checkIntegrityOffThread(file).then((report) => { done = true; return report; });
  while (!done) {
    sqlite.query('INSERT INTO maint_load (a) VALUES (?)').run(`w${writes}`);
    writes += 1;
    await Bun.sleep(1);
  }
  const report = await check;
  expect(report.findings).toEqual([]);
  expect(writes).toBeGreaterThan(0);
  expect((sqlite.query(`SELECT COUNT(*) AS n FROM maint_load WHERE a LIKE 'w%'`).get() as { n: number }).n).toBe(writes);
});

/** A port whose run waits until the test releases it, so two runs can be made to overlap. */
function gatedPort(result: PortResult = { findings: [], measurements: [] }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: MaintenanceCheck[] = [];
  const port: StoreMaintenancePort = {
    support: { optimize: { supported: true, label: 'test' }, integrity: { supported: false, reason: 'not on this target' } },
    claimMs: { optimize: HOUR, integrity: HOUR },
    run: async (check) => { calls.push(check); await gate; return result; },
  };
  return { port, calls, release };
}

function coreEnv(port: StoreMaintenancePort) {
  const fixture = sqliteEnv();
  const env = { ...fixture.serverEnv, storeMaintenance: port } as ServerEnv;
  const setLeaf = (leaf: string, value: unknown) => fixture.sqlite
    .query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 0, 'test')`)
    .run(leaf, JSON.stringify(value));
  return { env, setLeaf };
}

it('an unset or invalid cadence is stated as such and schedules nothing', async () => {
  const { env, setLeaf } = coreEnv(gatedPort().port);
  expect(await cadenceOf(env, 'optimize')).toEqual({ state: 'not_configured', leaf: 'maintenance.auto_optimize' });
  setLeaf('maintenance.auto_optimize', true);
  expect(await cadenceOf(env, 'optimize')).toEqual({ state: 'not_configured', leaf: 'maintenance.auto_optimize_interval_hours' });
  setLeaf('maintenance.auto_optimize_interval_hours', 5000);
  expect(await cadenceOf(env, 'optimize')).toMatchObject({ state: 'invalid', leaf: 'maintenance.auto_optimize_interval_hours' });
  expect(await maintenanceDue(env, 'optimize', 0)).toBe(false);
  expect(await runMaintenance(env, 'optimize', 'schedule', 0)).toMatchObject({ outcome: 'refused', refusal: 'not_configured' });
});

it('a scheduled run claims once per interval, and a concurrent run is refused while the first holds its claim', async () => {
  const gated = gatedPort();
  const { env, setLeaf } = coreEnv(gated.port);
  setLeaf('maintenance.auto_optimize', true);
  setLeaf('maintenance.auto_optimize_interval_hours', 24);
  const t0 = 1_000 * HOUR;
  expect(await maintenanceDue(env, 'optimize', t0)).toBe(true);
  const first = runMaintenance(env, 'optimize', 'schedule', t0);
  await Bun.sleep(5);
  expect(await runMaintenance(env, 'optimize', 'owner', t0)).toMatchObject({ outcome: 'refused', refusal: 'already_running' });
  expect(await maintenanceDue(env, 'optimize', t0)).toBe(false);
  gated.release();
  expect(await first).toMatchObject({ outcome: 'ran', record: { state: 'healthy', trigger: 'schedule' } });
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + HOUR)).toMatchObject({ outcome: 'refused', refusal: 'not_due' });
  expect(await maintenanceDue(env, 'optimize', t0 + 24 * HOUR)).toBe(true);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + 24 * HOUR)).toMatchObject({ outcome: 'ran' });
  expect(gated.calls).toEqual(['optimize', 'optimize']);
});

it('a run that outlived its claim never overwrites the newer run that took it', async () => {
  const slow = gatedPort({ findings: ['stale'], measurements: [] });
  const { env } = coreEnv(slow.port);
  const t0 = 1_000 * HOUR;
  const stale = runMaintenance(env, 'optimize', 'owner', t0);
  await Bun.sleep(5);
  const fresh = await runMaintenance({ ...env, storeMaintenance: gatedPortReleased() }, 'optimize', 'owner', t0 + 2 * HOUR);
  expect(fresh).toMatchObject({ outcome: 'ran', record: { state: 'healthy' } });
  slow.release();
  await stale;
  const latest = await latestOutcome(env, 'optimize');
  expect(latest?.runId).toBe(fresh.outcome === 'ran' ? fresh.record.runId : '');
  expect(latest?.state).toBe('healthy');
});

function gatedPortReleased(): StoreMaintenancePort {
  const gated = gatedPort();
  gated.release();
  return gated.port;
}

it('an unsupported check is refused with its reason and records nothing', async () => {
  const { env } = coreEnv(gatedPort().port);
  expect(await runMaintenance(env, 'integrity', 'owner', 0)).toEqual({ outcome: 'refused', refusal: 'unsupported', reason: 'not on this target' });
  expect(await latestOutcome(env, 'integrity')).toBeNull();
});

it('a port failure is recorded under its named class', async () => {
  const failing: StoreMaintenancePort = {
    ...gatedPortReleased(),
    run: async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan"); },
  };
  const { env } = coreEnv(failing);
  const answer = await runMaintenance(env, 'optimize', 'owner', 0);
  expect(answer).toMatchObject({ outcome: 'ran', record: { state: 'failed', errorClass: 'store_quota' } });
});

it('D1\'s documented limit refusals are named apart from other storage errors', () => {
  expect(classifyD1Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow")).toBe('store_quota');
  expect(classifyD1Error('D1_ERROR: Exceeded maximum DB size.')).toBe('store_size');
  expect(classifyD1Error("D1_ERROR: Your account has exceeded D1's maximum account storage limit, please contact Cloudflare")).toBe('store_size');
  expect(classifyD1Error('D1_ERROR: no such table: x')).toBe('db');
});
