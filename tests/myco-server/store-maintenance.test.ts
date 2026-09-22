/**
 * Store maintenance: the native port against a real volume, the claim and cadence every run goes through, and
 * the hosted target's named limit failures.
 *
 * The native checks run over a file on disk: the integrity check reads it from a thread of its own. What
 * they find is SQLite's own answer for a store this test damaged, never a stand-in.
 */
import { afterEach, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateAndSeed } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwner, asOwnerPost, ownerCookie } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { sqliteStoreMaintenance, checkIntegrityOffThread } from '@myco-server-worker/platform/bun/store-maintenance.js';
import { classifyD1Error } from '@myco-server-worker/platform/cloudflare/env.js';
import {
  boundFindings, cadenceOf, CLAIM_STATEMENTS, latestOutcome, maintenanceDue, MAX_FINDINGS, runMaintenance,
  type Exclusivity, type MaintenanceCheck, type PortResult, type StoreMaintenancePort,
} from '@myco-server-worker/core/store-maintenance.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { engineAssertions, runTick } from '@myco-server-worker/core/tick.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { createBunHandler } from '@myco-server-worker/entry/bun.js';
import { stampRequest } from '@myco-server-worker/core/activity.js';

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
  return { env, setLeaf, setRecord, settle: fixture.deferred.settle };
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
  expect(await runMaintenance(env, 'optimize', 'schedule', t0)).toMatchObject({ outcome: 'started', record: { state: 'running', trigger: 'schedule' } });
  expect(await maintenanceDue(env, 'optimize', t0 + HOUR)).toBe(false);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + HOUR)).toMatchObject({ outcome: 'refused', refusal: 'not_due' });
  expect(await maintenanceDue(env, 'optimize', t0 + 24 * HOUR)).toBe(true);
  expect(await runMaintenance(env, 'optimize', 'schedule', t0 + 24 * HOUR)).toMatchObject({ outcome: 'started' });
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

it('on the serving owner, an owner\'s run answers its running claim, and work in flight refuses a second run however long it has taken', async () => {
  const gated = gatedPort();
  const { env, settle } = coreEnv(gated.port);
  const t0 = 1_000 * HOUR;
  expect(await runMaintenance(env, 'optimize', 'owner', t0)).toMatchObject({ outcome: 'started', record: { state: 'running', trigger: 'owner' } });
  expect(await runMaintenance(env, 'optimize', 'owner', t0 + 48 * HOUR, { clock: () => t0 + 48 * HOUR })).toMatchObject({ outcome: 'refused', refusal: 'already_running' });
  expect(await maintenanceDue(env, 'optimize', t0 + 48 * HOUR)).toBe(false);
  gated.release();
  await settle();
  expect(await latestOutcome(env, 'optimize')).toMatchObject({ state: 'healthy', trigger: 'owner' });
  expect(gated.calls).toEqual(['optimize']);
  expect(await runMaintenance(env, 'optimize', 'owner', t0 + 49 * HOUR)).toMatchObject({ outcome: 'started' });
});

it('on the serving owner, a running record another process left is not a run', async () => {
  const { env, setRecord } = coreEnv(releasedPort());
  setRecord('optimize', {
    runId: 'dead', check: 'optimize', trigger: 'owner', state: 'running', startedAt: 0, claimExpiresAt: null, holder: 'a-process-that-died',
    finishedAt: null, errorClass: null, findings: [], findingsOmitted: 0, measurements: [], powerState: null,
  });
  expect(await runMaintenance(env, 'optimize', 'owner', HOUR)).toMatchObject({ outcome: 'started', record: { holder: 'this-process' } });
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
  const { env, settle } = coreEnv(failing);
  expect(await runMaintenance(env, 'optimize', 'owner', 0)).toMatchObject({ outcome: 'started' });
  await settle();
  expect(await latestOutcome(env, 'optimize')).toMatchObject({ state: 'failed', errorClass: 'store_quota' });
  const d1: StoreMaintenancePort = { ...failing, exclusivity: D1_LIKE };
  expect(await runMaintenance({ ...env, storeMaintenance: d1 }, 'optimize', 'owner', 0)).toMatchObject({ outcome: 'ran', record: { state: 'failed', errorClass: 'store_quota' } });
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

it('an owner reads every check and runs one through the served routes, on the path the clock takes', async () => {
  const e = sqliteEnv();
  const env = { ...e.env, ...OWNER_ENV };
  const listed = await (await worker.fetch(await asOwner('/api/maintenance'), env)).json() as { checks: Array<{ check: string; support: { supported: boolean }; cadence: { state: string }; latest: unknown }> };
  expect(listed.checks.map((c) => [c.check, c.support.supported, c.cadence.state, c.latest])).toEqual([
    ['optimize', true, 'not_configured', null],
    ['integrity', true, 'not_configured', null],
  ]);
  const ran = await worker.fetch(await asOwnerPost('/api/maintenance/integrity/run'), env);
  expect(ran.status).toBe(200);
  expect(await ran.json()).toMatchObject({ check: 'integrity', trigger: 'owner', state: 'healthy', findings: [] });
  const again = await (await worker.fetch(await asOwner('/api/maintenance'), env)).json() as { checks: Array<{ check: string; latest: { state: string } | null }> };
  expect(again.checks.find((c) => c.check === 'integrity')?.latest?.state).toBe('healthy');
  expect((await worker.fetch(await asOwnerPost('/api/maintenance/vacuum/run'), env)).status).toBe(404);
  const signedOut = new Request('https://s/api/maintenance/optimize/run', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' } });
  expect((await worker.fetch(signedOut, env)).status).toBe(401);
});

/** A native integrity port whose work waits until the test releases it, on the serving-owner exclusivity the self-hosted port declares. */
function pendingIntegrity() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: MaintenanceCheck[] = [];
  const port: StoreMaintenancePort = {
    support: { optimize: { supported: false, reason: 'not in this test' }, integrity: { supported: true, label: 'test' } },
    exclusivity: { kind: 'serving-owner', holder: 'this-process' },
    run: async (check) => { calls.push(check); await gate; return { findings: [], measurements: [] }; },
  };
  return { port, calls, release };
}

function nativeEnv(port: StoreMaintenancePort) {
  const { sqlite } = volume();
  for (const [leaf, value] of [['maintenance.auto_integrity_check', true], ['maintenance.auto_integrity_check_interval_hours', 24]] as const) {
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 0, 'test')`).run(leaf, JSON.stringify(value));
  }
  const env = serverEnvFromBunConfig({ sqlite, blobDir: fs.mkdtempSync(path.join(os.tmpdir(), 'myco-maintenance-blobs-')) });
  env.storeMaintenance = port;
  return { env, sqlite };
}

it('on the self-hosted clock, a scheduled integrity check is claimed and handed off; the next tick runs the lease sweep and every other job while it reads', async () => {
  const pending = pendingIntegrity();
  const { env } = nativeEnv(pending.port);
  const t0 = 1_000 * HOUR;
  await stampRequest(env.db, t0 - 31 * 60_000);
  const first = await runTick(env, t0, { wake: 'clock' });
  expect(first.jobs.find((j) => j.name === 'database-integrity-check')).toEqual({ name: 'database-integrity-check', changed: 1, failed: null });
  expect(pending.calls).toEqual(['integrity']);
  expect(await latestOutcome(env, 'integrity')).toMatchObject({ state: 'running', trigger: 'schedule', holder: 'this-process' });

  const next = await runTick(env, t0 + 60_000, { wake: 'clock' });
  expect(next.jobs.find((j) => j.name === 'worker-lease-sweep')).toEqual({ name: 'worker-lease-sweep', changed: 0, failed: null });
  expect(next.jobs.every((j) => j.failed === null)).toBe(true);
  expect(next.jobs.find((j) => j.name === 'database-integrity-check')?.changed).toBe(0);
  expect(await runMaintenance(env, 'integrity', 'owner', t0 + 60_000)).toMatchObject({ outcome: 'refused', refusal: 'already_running' });
  expect(pending.calls).toEqual(['integrity']);

  let settled = false;
  const settling = env.settle().then(() => { settled = true; });
  await Bun.sleep(5);
  expect(settled).toBe(false);
  pending.release();
  await settling;
  expect(await latestOutcome(env, 'integrity')).toMatchObject({ state: 'healthy', trigger: 'schedule', powerState: 'sleep' });
  expect(await runMaintenance(env, 'integrity', 'owner', t0 + 2 * 60_000)).toMatchObject({ outcome: 'started' });
});

it('a handed-off check that fails records its named class and releases its in-flight mark', async () => {
  const failing: StoreMaintenancePort = { ...pendingIntegrity().port, run: async () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); } };
  const { env } = nativeEnv(failing);
  const t0 = 1_000 * HOUR;
  expect(await runMaintenance(env, 'integrity', 'schedule', t0)).toMatchObject({ outcome: 'started', record: { state: 'running' } });
  await env.settle();
  expect(await latestOutcome(env, 'integrity')).toMatchObject({ state: 'failed', errorClass: expect.any(String), finishedAt: expect.any(Number) });
  expect((await latestOutcome(env, 'integrity'))?.errorClass).not.toBe('none');
  expect(await runMaintenance(env, 'integrity', 'owner', t0 + 1)).toMatchObject({ outcome: 'started' });
});

it('an unreadable maintenance record is reported by name without stopping the tick\'s other jobs', async () => {
  const { env, setLeaf } = coreEnv(releasedPort());
  setLeaf('maintenance.auto_optimize', true);
  setLeaf('maintenance.auto_optimize_interval_hours', 24);
  await env.db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('maintenance.optimize', 'not a record')`).run();
  await stampRequest(env.db, 1_000 * HOUR - 31 * 60_000);
  const logged: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  try {
    const report = await runTick(env, 1_000 * HOUR, { wake: 'clock' });
    expect(report.jobs.find((j) => j.name === 'worker-lease-sweep')).toEqual({ name: 'worker-lease-sweep', changed: 0, failed: null });
    expect(report.jobs.filter((j) => j.failed !== null).map((j) => j.name)).toEqual(['database-optimize']);
  } finally {
    log.mockRestore();
  }
  expect(logged.map((l) => JSON.parse(l) as Record<string, unknown>).find((e) => e.kind === 'maintenance_due_failed'))
    .toMatchObject({ error_class: expect.any(String) });
});

it('on the self-hosted target, close() waits for a handed-off check and records it before the store closes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-maintenance-close-'));
  dirs.push(dir);
  const databasePath = path.join(dir, 'myco.db');
  const seed = new Database(databasePath, { create: true });
  migrateAndSeed(seed);
  seed.close();
  const handler = await createBunHandler({ databasePath, blobDir: path.join(dir, 'blobs'), header: 'x-forwarded-for', wakeLoop: false });
  const pending = pendingIntegrity();
  handler.env.storeMaintenance = pending.port;
  await handler.env.db.prepare(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('maintenance.auto_integrity_check', 'true', 0, 't'), ('maintenance.auto_integrity_check_interval_hours', '24', 0, 't')`).run();
  expect(await runMaintenance(handler.env, 'integrity', 'schedule', 1_000 * HOUR)).toMatchObject({ outcome: 'started' });
  let closed = false;
  const closing = handler.close().then(() => { closed = true; });
  await Bun.sleep(5);
  expect(closed).toBe(false);
  pending.release();
  await closing;
  const reopened = new Database(databasePath, { readonly: true });
  const row = reopened.query(`SELECT value FROM schema_meta WHERE key = 'maintenance.integrity'`).get() as { value: string };
  reopened.close();
  expect(JSON.parse(row.value)).toMatchObject({ state: 'healthy', trigger: 'schedule' });
});

it('on the self-hosted target, an owner\'s run is answered at once with its running claim, reads as running, and lands after the answer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-maintenance-owner-'));
  dirs.push(dir);
  const databasePath = path.join(dir, 'myco.db');
  const seed = new Database(databasePath, { create: true });
  migrateAndSeed(seed);
  seed.close();
  const handler = await createBunHandler({ databasePath, blobDir: path.join(dir, 'blobs'), header: 'x-forwarded-for', wakeLoop: false, ...OWNER_ENV });
  const pending = pendingIntegrity();
  handler.env.storeMaintenance = pending.port;
  const owner = async (route: string, method = 'GET') => handler.fetch(new Request(`https://s${route}`, {
    method, headers: { cookie: await ownerCookie(), 'x-forwarded-for': '1.2.3.4', origin: 'https://s' },
  }));
  const ran = await owner('/api/maintenance/integrity/run', 'POST');
  expect(ran.status).toBe(200);
  expect(await ran.json()).toMatchObject({ check: 'integrity', trigger: 'owner', state: 'running', finishedAt: null, holder: 'this-process' });
  const listed = await (await owner('/api/maintenance')).json() as { checks: Array<{ check: string; running: boolean; latest: { state: string } | null }> };
  expect(listed.checks.find((c) => c.check === 'integrity')).toMatchObject({ running: true, latest: { state: 'running' } });
  const again = await owner('/api/maintenance/integrity/run', 'POST');
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ refusal: 'already_running' });
  pending.release();
  await handler.env.settle();
  const after = await (await owner('/api/maintenance')).json() as { checks: Array<{ check: string; running: boolean; latest: { state: string; trigger: string } | null }> };
  expect(after.checks.find((c) => c.check === 'integrity')).toMatchObject({ running: false, latest: { state: 'healthy', trigger: 'owner' } });
  await handler.close();
});
