/**
 * Store maintenance: the native port against a real volume, the claim and cadence every run goes through, and
 * the hosted target's named limit failures.
 *
 * The native checks run over a file on disk: the integrity check reads it from a thread of its own. What
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
  boundFindings, cadenceOf, CLAIM_STATEMENTS, latestOutcome, maintenanceDue, MAX_FINDINGS, runMaintenance,
  type Exclusivity, type MaintenanceCheck, type PortResult, type StoreMaintenancePort,
} from '@myco-server-worker/core/store-maintenance.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { engineAssertions, runTick } from '@myco-server-worker/core/tick.js';

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
  expect(result.findings).toEqual(['row 1 missing from index maint_child_label', 'foreign key: maint_child row 1 names a missing maint_parent']);
});

it('a native check that finds more than it keeps says so', async () => {
  const { sqlite, file } = volume();
  sqlite.exec('CREATE TABLE maint_parent (id INTEGER PRIMARY KEY)');
  sqlite.exec('CREATE TABLE maint_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES maint_parent(id))');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  sqlite.exec('INSERT INTO maint_child (parent) VALUES (97), (98), (99)');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const report = await checkIntegrityOffThread(file, { max: 2 });
  expect(report).toEqual({ findings: ['foreign key: maint_child row 1 names a missing maint_parent', 'foreign key: maint_child row 2 names a missing maint_parent'], truncated: true });
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
function gatedPort(exclusivity: Exclusivity = { kind: 'serving-owner', holder: 'this-process' }, result: PortResult = { findings: [], measurements: [] }) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: MaintenanceCheck[] = [];
  const port: StoreMaintenancePort = {
    support: { optimize: { supported: true, label: 'test' }, integrity: { supported: false, reason: 'not on this target' } },
    exclusivity,
    run: async (check) => { calls.push(check); await gate; return result; },
  };
  return { port, calls, release };
}

function releasedPort(exclusivity?: Exclusivity): StoreMaintenancePort {
  const gated = gatedPort(exclusivity);
  gated.release();
  return gated.port;
}

function coreEnv(port: StoreMaintenancePort) {
  const fixture = sqliteEnv();
  const env = { ...fixture.serverEnv, storeMaintenance: port } as ServerEnv;
  const setLeaf = (leaf: string, value: unknown) => fixture.sqlite
    .query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 0, 'test')`)
    .run(leaf, JSON.stringify(value));
  const setRecord = (check: MaintenanceCheck, record: Record<string, unknown>) => fixture.sqlite
    .query(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(`maintenance.${check}`, JSON.stringify(record));
  return { env, setLeaf, setRecord };
}

const D1_LIKE: Exclusivity = { kind: 'platform-limit', statementLimitMs: 30_000, statements: { optimize: 1, integrity: 2 } };

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

it('a scheduled run starts once per interval', async () => {
  const { env, setLeaf } = coreEnv(releasedPort());
  setLeaf('maintenance.auto_optimize', true);
  setLeaf('maintenance.auto_optimize_interval_hours', 24);
  const t0 = 1_000 * HOUR;
  expect(await maintenanceDue(env, 'optimize', t0)).toBe(true);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0)).toMatchObject({ outcome: 'ran', recorded: true, record: { state: 'healthy', trigger: 'schedule' } });
  expect(await maintenanceDue(env, 'optimize', t0 + HOUR)).toBe(false);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + HOUR)).toMatchObject({ outcome: 'refused', refusal: 'not_due' });
  expect(await maintenanceDue(env, 'optimize', t0 + 24 * HOUR)).toBe(true);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + 24 * HOUR)).toMatchObject({ outcome: 'ran' });
});

it('the engine runs a due check on its own clock alone, holds an idle Deployment at sleep for it, and lets go once it ran', async () => {
  const gated = gatedPort();
  gated.release();
  const { env, setLeaf } = coreEnv(gated.port);
  setLeaf('maintenance.auto_optimize', true);
  setLeaf('maintenance.auto_optimize_interval_hours', 24);
  const t0 = 1_000 * HOUR;
  const held = (await engineAssertions(env, t0)).map((a) => a.name);
  expect(held).toContain('maintenance:due');
  const requested = await runTick(env, t0, { wake: 'request' });
  expect(requested.jobs.map((j) => j.name)).not.toContain('database-optimize');
  expect(gated.calls).toEqual([]);
  const clocked = await runTick(env, t0, { wake: 'clock' });
  expect(clocked.state).toBe('sleep');
  expect(clocked.jobs.find((j) => j.name === 'database-optimize')).toEqual({ name: 'database-optimize', changed: 1, failed: null });
  expect(clocked.jobs.find((j) => j.name === 'database-integrity-check')).toEqual({ name: 'database-integrity-check', changed: 0, failed: null });
  expect((await engineAssertions(env, t0 + HOUR)).map((a) => a.name)).not.toContain('maintenance:due');
  expect((await runTick(env, t0 + HOUR, { wake: 'clock' })).state).toBe('deep_sleep');
  expect(gated.calls).toEqual(['optimize']);
  expect(await latestOutcome(env, 'optimize')).toMatchObject({ state: 'healthy', trigger: 'schedule', powerState: 'sleep' });
});

it('on the serving owner, work in flight refuses a second run however long it has taken', async () => {
  const gated = gatedPort();
  const { env } = coreEnv(gated.port);
  const t0 = 1_000 * HOUR;
  const first = runMaintenance(env, 'optimize', 'owner', t0);
  await Bun.sleep(5);
  expect(await runMaintenance(env, 'optimize', 'owner', t0 + 48 * HOUR, { clock: () => t0 + 48 * HOUR })).toMatchObject({ outcome: 'refused', refusal: 'already_running' });
  expect(await maintenanceDue(env, 'optimize', t0 + 48 * HOUR)).toBe(false);
  gated.release();
  expect(await first).toMatchObject({ outcome: 'ran', recorded: true });
  expect(gated.calls).toEqual(['optimize']);
  expect(await runMaintenance(env, 'optimize', 'owner', t0 + 49 * HOUR)).toMatchObject({ outcome: 'ran' });
});

it('on the serving owner, a running record another process left is not a run', async () => {
  const { env, setRecord } = coreEnv(releasedPort());
  setRecord('optimize', {
    runId: 'dead', check: 'optimize', trigger: 'owner', state: 'running', startedAt: 0, claimExpiresAt: null, holder: 'a-process-that-died',
    finishedAt: null, errorClass: null, findings: [], findingsOmitted: 0, measurements: [], powerState: null,
  });
  expect(await runMaintenance(env, 'optimize', 'owner', HOUR)).toMatchObject({ outcome: 'ran', recorded: true, record: { holder: 'this-process' } });
});

it('on a platform-limited store, a run inside its bound refuses another, and past it a stale finish never replaces the newer record', async () => {
  const slow = gatedPort(D1_LIKE, { findings: ['stale'], measurements: [] });
  const { env } = coreEnv(slow.port);
  const t0 = 1_000 * HOUR;
  const stale = runMaintenance(env, 'optimize', 'owner', t0, { clock: () => t0 });
  await Bun.sleep(5);
  const bound = (1 + CLAIM_STATEMENTS) * 30_000;
  expect(await runMaintenance(env, 'optimize', 'owner', t0 + bound - 1, { clock: () => t0 + bound - 1 })).toMatchObject({ outcome: 'refused', refusal: 'already_running' });
  const fresh = await runMaintenance({ ...env, storeMaintenance: releasedPort(D1_LIKE) }, 'optimize', 'owner', t0 + bound, { clock: () => t0 + bound });
  expect(fresh).toMatchObject({ outcome: 'ran', recorded: true, record: { state: 'healthy' } });
  slow.release();
  expect(await stale).toMatchObject({ outcome: 'ran', recorded: false });
  const latest = await latestOutcome(env, 'optimize');
  expect(latest?.runId).toBe(fresh.outcome === 'ran' ? fresh.record.runId : '');
});

it('an unsupported check is refused with its reason and records nothing', async () => {
  const { env } = coreEnv(gatedPort().port);
  expect(await runMaintenance(env, 'integrity', 'owner', 0)).toEqual({ outcome: 'refused', refusal: 'unsupported', reason: 'not on this target' });
  expect(await latestOutcome(env, 'integrity')).toBeNull();
});

it('a port failure is recorded under its named class', async () => {
  const failing: StoreMaintenancePort = {
    ...releasedPort(),
    run: async () => { throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan"); },
  };
  const { env } = coreEnv(failing);
  expect(await runMaintenance(env, 'optimize', 'owner', 0)).toMatchObject({ outcome: 'ran', record: { state: 'failed', errorClass: 'store_quota' } });
});

it('findings past the kept limit are counted, and the outcome keeps its state', () => {
  const many = Array.from({ length: MAX_FINDINGS + 3 }, (_, i) => `problem ${i}`);
  expect(boundFindings(many)).toMatchObject({ findingsOmitted: 3 });
  expect(boundFindings(many).findings).toHaveLength(MAX_FINDINGS);
});

it('D1\'s documented limit refusals are named apart from other storage errors', () => {
  expect(classifyD1Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow")).toBe('store_quota');
  expect(classifyD1Error('D1_ERROR: Exceeded maximum DB size.')).toBe('store_size');
  expect(classifyD1Error("D1_ERROR: Your account has exceeded D1's maximum account storage limit, please contact Cloudflare")).toBe('store_size');
  expect(classifyD1Error('D1_ERROR: no such table: x')).toBe('db');
});
