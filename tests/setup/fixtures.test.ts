import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSandboxChildEnv } from '../../scripts/test-environment.mjs';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { fleetReports, readWorkerFleet } from '@myco-server-worker/core/worker-contacts.js';
import { producedSql } from '@myco-server-worker/read/run-outcome.js';
import { FIRST_MEMBER_KEY } from '@myco-server-worker/core/first-owner.js';
import { handleDevicePoll } from '@myco-server-worker/auth/device.js';
import { readRunnerRecord } from '@myco/runner/runner-registry.js';
import { readLocalRecord, readLocalSecrets } from '@myco/server/local.js';
import { defaultSpec, servicePaths } from '@myco/server/service.js';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { readDeploymentMembership } from '@myco/member/registry.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { seededSqlite, sqliteD1 } from '../myco-server/helpers/d1.js';
import { legacyFixtureHome, LEGACY_PROJECT_IDS } from './fixtures/legacy-home.js';
import { seedMisleadingHistory } from './fixtures/misleading-history.js';
import { interruptOnce, refuseImportAfter, SETUP_INTERRUPTION_POINTS, SetupInterrupted } from './fixtures/interruption.js';
import { convertedBeforeInstall, createdBeforeSignIn, enrolledBeforeInstall, expiredOwnerLink, timedOutApproval } from './fixtures/interrupted-state.js';
import { fakeGitHub, SETUP_APP } from './fixtures/github.js';
import { cutoverAfterFirstProject } from './fixtures/cutover.js';

const NOW = Date.UTC(2026, 9, 10);
const roots: string[] = [];
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-fixture-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('misleading setup history', () => {
  for (const target of ['native', 'd1-adapter'] as const) it(`seeds tempting history that the existing ${target} projections reject`, async () => {
    const sqlite = seededSqlite();
    const db = target === 'native' ? sqliteRelationalStore(sqlite) : sqliteD1(sqlite);
    try {
      const h = await seedMisleadingHistory(db, NOW);
      expect(await db.prepare('SELECT session_id, last_live_received_at FROM sessions WHERE project_id = ?').bind(h.projectId).first<Record<string, unknown>>())
        .toEqual({ session_id: h.sessionId, last_live_received_at: null });
      expect(await db.prepare(`SELECT status, ${producedSql('a')} AS produced FROM agent_runs a WHERE a.id = ?`).bind(h.runId).first<Record<string, unknown>>())
        .toEqual({ status: 'completed', produced: 0 });
      const fleet = await readWorkerFleet(db, NOW);
      expect(fleet.find((row) => row.runner?.id === h.runnerId || row.credentialId === h.runnerId)).toMatchObject({ recent: false });
      expect(fleetReports(fleet)).toEqual([]);
      expect(await db.prepare('SELECT machine_id FROM machine_claims WHERE member_id = ?').bind(h.memberId).first<Record<string, unknown>>())
        .toEqual({ machine_id: h.machineId });
    } finally { sqlite.close(); }
  });
});

describe('persisted setup interruption fixtures', () => {
  it('keeps completed native creation with sign-in still absent', () => {
    const paths = createdBeforeSignIn(path.join(fresh(), 'myco'), { library: null, vec0: null });
    expect(readLocalRecord(paths)).toMatchObject({ sourceFrom: 'socket', port: 8787 });
    const secrets = readLocalSecrets(paths);
    expect(secrets.SESSION_SECRET).toBeString();
    expect(secrets.GITHUB_CLIENT_ID).toBeUndefined();
    const sqlite = new Database(paths.databasePath, { readonly: true });
    try { expect(sqlite.query('SELECT COUNT(*) AS n FROM members').get()).toEqual({ n: 0 }); } finally { sqlite.close(); }
  });

  it('leaves the first-owner receipt pending when its link expires', async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
      const db = sqliteRelationalStore(sqlite);
      const link = await expiredOwnerLink(db, NOW);
      expect(link.expiresAt).toBeLessThan(NOW);
      expect(await db.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(FIRST_MEMBER_KEY).first<Record<string, unknown>>()).toEqual({ value: link.memberId });
      expect(await db.prepare('SELECT github_id FROM members WHERE id = ?').bind(link.memberId).first<Record<string, unknown>>()).toEqual({ github_id: null });
      expect(await db.prepare('SELECT used_at, revoked_at FROM identity_link_authorities WHERE member_id = ?').bind(link.memberId).first<Record<string, unknown>>())
        .toEqual({ used_at: null, revoked_at: null });
    } finally { sqlite.close(); }
  });

  it('times out a real device request without waiting or recording an approval', async () => {
    const fixture = sqliteEnv();
    try {
      const approval = await timedOutApproval(fixture.serverEnv, NOW);
      const response = await handleDevicePoll(fixture.serverEnv, new Request('https://setup.invalid/auth/device/poll', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: approval.device_code }),
      }), NOW);
      expect(await response.json() as { error: string }).toEqual({ error: 'expired_token' });
      expect(fixture.sqlite.query('SELECT decision FROM device_requests').get()).toEqual({ decision: null });
    } finally { fixture.sqlite.close(); }
  });

  it('retains runner enrollment when service installation has not completed', async () => {
    const home = fresh();
    const mycoHome = path.join(home, 'myco');
    const record = await enrolledBeforeInstall(mycoHome);
    expect(readRunnerRecord(record.serverUrl, mycoHome)).toEqual(record);
    const spec = defaultSpec(path.join(mycoHome, 'bin', 'myco'), home, 'darwin', mycoHome);
    expect(fs.existsSync(servicePaths(spec, 'darwin').unitFile)).toBe(false);
  });

  it('persists a private conversion artifact before the installation checkpoint', async () => {
    const github = fakeGitHub();
    const stop = interruptOnce('after-github-conversion-before-install');
    const artifact = await convertedBeforeInstall(fresh(), github.registrationFetch);
    expect(() => stop.checkpoint('after-github-conversion-before-install')).toThrow(SetupInterrupted);
    expect(JSON.parse(fs.readFileSync(artifact.file, 'utf8'))).toMatchObject({ ...SETUP_APP, url: 'https://setup.invalid' });
    expect(fs.statSync(artifact.file).mode & 0o777).toBe(0o600);
    expect(github.calls).toHaveLength(1);
  });

  for (const point of SETUP_INTERRUPTION_POINTS) it(`interrupts once at ${point} and allows a resume`, () => {
    const stop = interruptOnce(point);
    const other = SETUP_INTERRUPTION_POINTS.find((candidate) => candidate !== point)!;
    stop.checkpoint(other);
    expect(() => stop.checkpoint(point)).toThrow(SetupInterrupted);
    expect(() => stop.checkpoint(point)).not.toThrow();
    expect(stop.visited).toEqual([other, point, point]);
  });

  it('returns a terminal 403 mid-import and does not delegate refused or retried requests', async () => {
    const accepted: string[] = [];
    const refusal = refuseImportAfter(1, async (input) => { accepted.push(new Request(input).url); return Response.json({ accepted: true }); });
    expect((await refusal.fetchImpl('https://setup.invalid/legacy', { method: 'POST' })).status).toBe(200);
    expect((await refusal.fetchImpl('https://setup.invalid/legacy', { method: 'POST' })).status).toBe(403);
    expect((await refusal.fetchImpl('https://setup.invalid/legacy', { method: 'POST' })).status).toBe(403);
    expect(accepted).toHaveLength(1);
    expect(refusal.requests).toHaveLength(3);
  });
});

it('builds a coherent, non-executable 1.4 fixture home', () => {
  const fixture = legacyFixtureHome(fresh());
  assertSandboxChildEnv(fixture.root, fixture.env);
  for (const name of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'MYCO_HOME', 'TMPDIR']) {
    expect(fixture.env[name] === fixture.root || fixture.env[name]!.startsWith(fixture.root + path.sep)).toBe(true);
  }
  expect(fs.statSync(fixture.binary).mode & 0o111).toBe(0);
  const sqlite = new Database(fixture.vault, { readonly: true });
  try {
    expect(sqlite.query('SELECT version FROM schema_version').get()).toEqual({ version: 76 });
    expect(sqlite.query('SELECT DISTINCT project_id FROM sessions ORDER BY project_id').all()).toEqual(LEGACY_PROJECT_IDS.map((project_id) => ({ project_id })));
    expect(sqlite.query('SELECT COUNT(*) AS n FROM prompt_batches').get()).toEqual({ n: 2 });
    expect(sqlite.query('SELECT COUNT(*) AS n FROM spores').get()).toEqual({ n: 2 });
  } finally { sqlite.close(); }
  expect(fs.readFileSync(path.join(fixture.home, '.claude', 'settings.json'), 'utf8')).toContain(fixture.binary);
  expect(fs.readFileSync(path.join(fixture.home, '.codex', 'config.toml'), 'utf8')).toContain(fixture.binary);
  expect(fs.readdirSync(fixture.agentsDir)).toEqual(['co.goondocks.myco.plist']);
});

for (const boundary of ['projects', 'destinations'] as const) it(`seeds persisted cutover progress between ${boundary}, with skipped capture to preserve`, () => {
  const fixture = cutoverAfterFirstProject(fresh(), boundary);
  for (const route of fixture.routes) expect(readDeploymentMembership(route.serverUrl, fixture.mycoHome)).toMatchObject({ serverUrl: route.serverUrl });
  const held = new LegacyLedger(fixture.mycoHome, fixture.completed.serverUrl, fixture.completed.id).read();
  expect([...held.sessions]).toEqual([fixture.completed.sessionId]);
  expect(held.sources.get(fixture.completed.sessionId)).toBe('vault');
  expect(new LegacyLedger(fixture.mycoHome, fixture.pending.serverUrl, fixture.pending.id).read().sessions.size).toBe(0);
  expect(fixture.completed.serverUrl === fixture.pending.serverUrl).toBe(boundary === 'projects');
  expect([...fixture.skips]).toEqual(['proj_setup_skipped']);
  const vault = new Database(fixture.legacy.vault, { readonly: true });
  try {
    expect(vault.query('SELECT project_id FROM sessions WHERE project_id = ?').get([...fixture.skips][0]!)).toEqual({ project_id: 'proj_setup_skipped' });
  } finally { vault.close(); }
  expect(fixture.skipped.sessionIds()).toContain(fixture.skippedSessionId);
  expect(fixture.skipped.readRecords(fixture.skippedSessionId)).toMatchObject([{ payload: { text: 'Retain skipped capture' } }]);
});
