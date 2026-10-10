import { readTaskStartPreview } from '@myco-server-worker/read/task-start.js';
import { readFleetProjection } from '@myco-server-worker/read/fleet.js';
/**
 * Runners: a Deployment-owned execution identity, registered through the device flow, that claims and drives the
 * Deployment's queued work on its own credential and nothing else.
 *
 * Every request here goes through the deployed pipeline (`createServer`), the way a runner client, its harness child
 * and a dashboard approver reach it. What each test holds:
 * - registration is a device request of the runner subject, approved by a live owner or administrator, committing the
 *   runner and its client-generated credential together; a member request is never redeemed as a runner and back;
 * - a runner-only machine, with no membership at all, completes a title-summary run;
 * - a runner credential reaches the worker control plane and its own two routes, and is refused everywhere else;
 * - capacity, pause, removal, rotation and replay, each at the write that decides it.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID, PROJECT_HEADER, WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { DEVICE_TTL_MS } from '@myco-server-worker/auth/device.js';
import { RUNNER_TOKEN_REFRESH_WINDOW_MS } from '@myco-server-worker/auth/runners.js';
import { claimNextRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { workerLiveness } from '@myco-server-worker/core/runs.js';
import { runnerObservationStatement, readWorkerFleet, pruneWorkerContacts, recordWorkerContact, WORKER_CONTACT_RETENTION_MS } from '@myco-server-worker/core/worker-contacts.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { prepareRecoveredTenant } from '@myco-server-worker/core/recovered-tenant.js';
import { renameRunner, controlRunner, registerRunner, runnerWriteStore, RunnerWriteRefused, RUNNER_LINEAGE_IDLE_MS } from '@myco-server-worker/auth/runners.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { memberHeaders, PROTOCOL, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';

const NOW = 1_800_000_000_000;
const OWNER = 'mem_machine_1';
const MEMBER = 'mem_machine_2';
const ADMIN = 'mem_machine_3';
const OWNER_SUB = '583231';
const MEMBER_SUB = '770001';
const ADMIN_SUB = '770003';
const OFFERED = [offeredHarness('claude-code')];
type Json = Record<string, any>;

const bearer = (): string => `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

function rig(options: { onSql?: (sql: string) => void; deploymentId?: string } = {}) {
  let hook: ((sql: string) => void) | undefined;
  const e = sqliteEnv({ workerLogin: true, onSql: (sql) => { options.onSql?.(sql); hook?.(sql); } });
  if (options.deploymentId !== undefined) e.sqlite.run(`UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'`, [options.deploymentId]);
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`UPDATE deployment_ownership SET member_id = ?, revision = 1 WHERE id = 1`, [OWNER]);
  e.sqlite.run(`UPDATE members SET role = 'member', github_id = ? WHERE id = ?`, [MEMBER_SUB, MEMBER]);
  e.sqlite.run(`UPDATE members SET role = 'admin', github_id = ? WHERE id = ?`, [ADMIN_SUB, ADMIN]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => '192.0.2.10', fetchImpl: () => { throw new Error('unexpected OAuth'); } });
  const env = { ...e.serverEnv, secrets: OWNER_ENV };
  const send = (path: string, init: RequestInit) => server.handleRequest(new Request(`https://s${path}`, init), env);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    send(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://s', ...headers }, body: JSON.stringify(body) });
  const asSession = async (path: string, body: unknown, sub = OWNER_SUB, method = 'POST') => {
    const cookie = await ownerCookie(e.db, now, sub);
    return method === 'GET' ? send(path, { method, headers: { cookie } }) : post(path, body, { cookie });
  };
  const asRunner = (token: string, path: string, body: unknown = {}) => post(path, body, { authorization: `Bearer ${token}`, ...PROTOCOL });
  const json = async (res: Response | Promise<Response>): Promise<Json> => await (await res).json() as Json;
  const start = async (name = 'mini', candidate = bearer(), replace = false): Promise<Json> => ({ candidate, ...await json(post('/auth/runner/start', { name, machineId: `rm_${crypto.randomUUID()}`, machineName: 'Mac mini', os: 'darwin', candidate, ...(replace ? { replace: true } : {}) })) });
  const poll = (deviceCode: string) => json(post('/auth/runner/poll', { device_code: deviceCode }));
  /** Start, approve as the owner and poll: a registered runner and its bearer. */
  const register = async (name = 'mini') => {
    const started = await start(name);
    const approved = await json(asSession('/api/device/approve-runner', { user_code: started.user_code }));
    expect(approved).toMatchObject({ approved: true });
    now += 5000;
    const polled = await poll(started.device_code);
    expect(polled).toMatchObject({ registered: true, runnerId: approved.runnerId, name });
    return { token: started.candidate as string, runnerId: approved.runnerId as string };
  };
  let sessions = 0;
  /** One queued title-summary run, as a session's end asks for one. */
  const queueTitling = async () => {
    const id = `s${++sessions}`;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [id, now - 10_000, now, now - 10_000, now]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', ?, ?, ?, 'add a retry to the runner', 'user', ?, ?, ?, 'tok_1', ?)`, [id, `p_${id}`, `e_${id}`, `h_${id}`, now - 5000, now - 5000, now - 5000]);
    expect((await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: id, now, origin: 'https://s' })).outcome).toBe('queued');
    return id;
  };
  const claim = (token: string) => json(asRunner(token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES }));
  /** A tool call over a run's own credential, as the harness child makes it. */
  const asRun = async (token: string, name: string, input: Json, method = 'tools/call') => json(post('/mcp',
    { jsonrpc: '2.0', id: 1, method, params: method === 'tools/call' ? { name, arguments: input } : {} },
    memberHeaders(token, { [PROJECT_HEADER]: 'proj_1' })));
  const row = (sql: string, ...params: unknown[]) => e.sqlite.query(sql).get(...(params as never[])) as Json | null;
  return {
    e, env, post, asSession, asRunner, json, start, poll, register, queueTitling, claim, asRun, row,
    now: () => now, advance: (ms: number) => { now += ms; }, at: (instant: number) => { now = instant; },
    arm: (fn: ((sql: string) => void) | undefined) => { hook = fn; },
  };
}

describe('legacy execution inventory', () => {
  it('owner and admin see member executors with contact and live leases, separate from runners', async () => {
    const r = rig();
    try {
      await r.register();
      const legacy = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'legacy-mini' }, r.now());
      await r.queueTitling();
      const claimed = await r.json(r.asRunner(legacy.token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES }));
      expect(claimed.claimed).toBe(true);
      r.e.sqlite.run('UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?', [r.now() - 300000, legacy.tokenId]);
      for (const role of [OWNER_SUB, ADMIN_SUB]) {
        const response = await r.asSession('/api/workers/legacy', {}, role, 'GET');
        expect(response.status).toBe(200);
        const inventory = await r.json(response);
        expect(inventory.workers).toHaveLength(1);
        expect(inventory.workers[0]).toMatchObject({ credentialId: legacy.tokenId, machineId: 'legacy-mini', runner: null, recent: false, busy: { runId: claimed.run.id } });
        expect(JSON.stringify(inventory)).not.toContain(legacy.token);
      }
      expect((await r.asSession('/api/workers/legacy', {}, MEMBER_SUB, 'GET')).status).toBe(404);
    } finally { r.e.sqlite.close(); }
  });
});

describe('runner registration through the device flow', () => {
  it('names the runner on the approval, binds the client\'s candidate at the approval, and mints nothing at the poll', async () => {
    const r = rig();
    try {
      const started = await r.start('homelab-mini');
      expect(started).toMatchObject({ verification_uri: 'https://s/device', verification_uri_complete: `https://s/device?code=${started.user_code}`, interval: 5 });
      const stored = JSON.stringify(r.e.sqlite.query('SELECT * FROM device_requests').all());
      for (const secret of [started.candidate, started.device_code, started.user_code]) expect(stored).not.toContain(secret);
      expect(r.row('SELECT subject, runner_name, candidate_hash FROM device_requests')).toEqual({ subject: 'runner', runner_name: 'homelab-mini', candidate_hash: await sha256Hex(started.candidate) });

      expect(await r.json(r.asSession('/api/device/preview', { user_code: started.user_code })))
        .toMatchObject({ subject: 'runner', runnerName: 'homelab-mini', scope: 'runner', machineName: 'Mac mini', os: 'darwin' });
      expect(await r.poll(started.device_code)).toEqual({ error: 'authorization_pending' });
      // A member sign-in's approval and poll never take a runner request.
      expect((await r.asSession('/api/device/approve', { user_code: started.user_code })).status).toBe(409);
      expect(await r.json(r.post('/auth/device/poll', { device_code: started.device_code }))).toEqual({ error: 'invalid_grant' });

      const approved = await r.json(r.asSession('/api/device/approve-runner', { user_code: started.user_code }, ADMIN_SUB));
      const runnerId = String(approved.runnerId);
      expect(runnerId).toMatch(/^rn_/);
      expect(approved).toEqual({ approved: true, runnerId });
      expect(r.row('SELECT name, state, credential_epoch, created_by_member FROM runners')).toEqual({ name: 'homelab-mini', state: 'enabled', credential_epoch: 1, created_by_member: ADMIN });
      expect(r.row('SELECT token_hash, epoch FROM runner_credentials')).toEqual({ token_hash: await sha256Hex(started.candidate), epoch: 1 });
      expect(r.row('SELECT action, actor_member FROM runner_audit')).toEqual({ action: 'registered', actor_member: ADMIN });
      expect(r.row('SELECT decision, subject FROM device_decision_audit')).toEqual({ decision: 'approved', subject: 'runner' });
      // The registration made no member, no member credential and no machine claim.
      expect(r.row('SELECT COUNT(*) AS n FROM member_credentials')).toEqual({ n: 0 });
      expect(r.row(`SELECT COUNT(*) AS n FROM machine_claims`)).toEqual({ n: 0 });

      r.advance(5000);
      const polled = await r.poll(started.device_code);
      expect(polled).toEqual({ registered: true, runnerId, name: 'homelab-mini', deploymentId: r.row(`SELECT value FROM schema_meta WHERE key = 'deployment_id'`)!.value });
      r.advance(5000);
      expect(await r.poll(started.device_code)).toEqual(polled);
      expect(r.row('SELECT COUNT(*) AS n FROM runner_credentials')).toEqual({ n: 1 });

      // A client that lost the poll's answer recovers its registration with the candidate it already holds.
      const contact = await r.json(r.asRunner(started.candidate, '/runners/contact', { machineId: 'mini-1', os: 'darwin', version: '2.0.0' }));
      expect(contact).toMatchObject({ persisted: true, runner: { id: runnerId, name: 'homelab-mini', state: 'enabled' }, credential: { id: r.row('SELECT id FROM runner_credentials')!.id } });

      // The request is spent: a second approval registers nothing.
      expect((await r.asSession('/api/device/approve-runner', { user_code: started.user_code })).status).toBe(409);
      expect(r.row('SELECT COUNT(*) AS n FROM runners')).toEqual({ n: 1 });
    } finally { r.e.sqlite.close(); }
  });

  it('never approves a member sign-in as a runner, nor reuses a candidate already bound', async () => {
    const r = rig();
    try {
      const member = await r.json(r.post('/auth/device/start', { machineId: 'laptop_1', machineName: 'Laptop', os: 'darwin' }));
      expect((await r.asSession('/api/device/approve-runner', { user_code: member.user_code })).status).toBe(409);
      expect(await r.json(r.post('/auth/runner/poll', { device_code: member.device_code }))).toEqual({ error: 'invalid_grant' });
      const { token } = await r.register();
      expect((await r.post('/auth/runner/start', { name: 'again', machineId: 'rm_2', machineName: 'Mini', os: 'darwin', candidate: token })).status).toBe(400);
      expect(r.row('SELECT COUNT(*) AS n FROM runners')).toEqual({ n: 1 });
    } finally { r.e.sqlite.close(); }
  });

  it('refuses an ordinary member, a held administrator, an approver demoted before the commit and an expired request, leaving nothing', async () => {
    const r = rig();
    try {
      const empty = () => ({ runners: r.row('SELECT COUNT(*) AS n FROM runners'), credentials: r.row('SELECT COUNT(*) AS n FROM runner_credentials'), decided: r.row('SELECT COUNT(*) AS n FROM device_requests WHERE decision IS NOT NULL') });
      const none = { runners: { n: 0 }, credentials: { n: 0 }, decided: { n: 0 } };
      const asked = await r.start();
      expect((await r.asSession('/api/device/approve-runner', { user_code: asked.user_code }, MEMBER_SUB)).status).toBe(403);
      expect(empty()).toEqual(none);

      r.e.sqlite.run('UPDATE members SET revoked_at = ?, revoked_by = ? WHERE id = ?', [NOW, FOREIGN_LINEAGE_REVOKER, ADMIN]);
      expect((await r.asSession('/api/device/approve-runner', { user_code: asked.user_code }, ADMIN_SUB)).status).toBe(401);
      expect(empty()).toEqual(none);
      r.e.sqlite.run('UPDATE members SET revoked_at = NULL, revoked_by = NULL WHERE id = ?', [ADMIN]);

      // The approver's standing is read again by the batch that commits: a demotion after admission refuses it whole.
      r.arm((sql) => { if (/INSERT INTO runners/.test(sql)) r.e.sqlite.run(`UPDATE members SET role = 'member' WHERE id = ?`, [ADMIN]); });
      expect((await r.asSession('/api/device/approve-runner', { user_code: asked.user_code }, ADMIN_SUB)).status).toBe(403);
      r.arm(undefined);
      expect(empty()).toEqual(none);
      expect(r.row('SELECT COUNT(*) AS n FROM runner_audit')).toEqual({ n: 0 });

      r.advance(DEVICE_TTL_MS);
      expect((await r.asSession('/api/device/approve-runner', { user_code: asked.user_code })).status).toBe(409);
      expect(await r.poll(asked.device_code)).toEqual({ error: 'expired_token' });
      expect(empty()).toEqual(none);
    } finally { r.e.sqlite.close(); }
  });
});

describe('a runner-only machine', () => {
  it('claims, runs and closes a title-summary run with no membership: its run is handed no stored login, and history names the runner', async () => {
    const r = rig();
    try {
      // A stored login would be what a legacy worker's run is handed; a runner's run is handed none.
      r.e.sqlite.run(`UPDATE deployment_settings SET value = '"deployment"' WHERE leaf = 'agent.harnesses.claude-code.credential'`);
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const opened: string[] = [];
      r.arm((sql) => { if (/deployment_secrets/.test(sql)) opened.push(sql); });
      const claimed = await r.claim(token);
      r.arm(undefined);
      expect(opened).toEqual([]);
      expect(claimed).toMatchObject({ persisted: true, claimed: true, run: { task: 'title-summary', credentialEnv: {} } });
      const run = claimed.run;
      expect(r.row('SELECT leased_by, leased_runner_id, status FROM agent_runs WHERE id = ?', run.id)).toEqual({ leased_by: null, leased_runner_id: runnerId, status: 'running' });
      expect(r.row('SELECT owner_kind, runner_id, attempt_id FROM agent_run_attempts WHERE run_id = ?', run.id)).toEqual({ owner_kind: 'runner', runner_id: runnerId, attempt_id: run.attemptId });

      const material = await r.asRun(run.runToken, 'myco_run_sessions', { op: 'material', project: 'proj_1' });
      expect(JSON.parse(material.result.content[0].text).session_id).toBe('s1');
      await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', title: 'Add a retry to the runner', summary: 'The runner gained a retry.' });
      await r.asRun(run.runToken, 'myco_run', { op: 'report', audit: RUN_AUDIT, action: 'summary', summary: 'titled one session' });

      expect(await r.json(r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId }))).toMatchObject({ persisted: true, held: true });
      // A runner names its attempt; a renewal without one is no renewal.
      expect(await r.json(r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id }))).toMatchObject({ persisted: true, held: false });
      expect((await workerLiveness(r.e.db, r.now())).workersBusy).toBe(1);
      expect(await r.json(r.asRunner(token, '/worker/end', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId, status: 'completed' })))
        .toEqual({ persisted: true, ended: true, status: 'completed' });
      expect(r.row('SELECT status, error, leased_runner_id FROM agent_runs WHERE id = ?', run.id)).toEqual({ status: 'completed', error: null, leased_runner_id: runnerId });
      expect(r.row('SELECT title FROM sessions WHERE session_id = ?', 's1')).toEqual({ title: 'Add a retry to the runner' });
      expect((await getRunDetail(r.e.db, { projectId: 'proj_1' }, run.id, r.now(), OWNER))?.run.worker).toMatchObject({ runner: { id: runnerId, name: 'mini' }, member: null, machineName: 'mini' });
      expect(r.row('SELECT COUNT(*) AS n FROM members WHERE id NOT IN (SELECT id FROM members WHERE id LIKE ? OR id IN (?, ?, ?))', 'mem_machine_%', 'mem_anon', 'mem_m', HARNESS_MEMBER_ID)).toEqual({ n: 0 });
    } finally { r.e.sqlite.close(); }
  });
});

describe('what a runner credential reaches', () => {
  it('answers on the worker control plane and its own routes, and 401 on every other route; a member credential is 401 on a runner route', async () => {
    const r = rig();
    try {
      const { token } = await r.register();
      const member = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'machine_a' }, r.now());
      const reached: string[] = [];
      for (const route of ROUTES.filter((x) => x.auth !== 'public')) {
        const path = route.path.replace(/\{sha256\}|\{key\}/g, 'a'.repeat(64)).replace(/\{[^}]+\}/g, 'x');
        const res = await r.post(path, {}, { authorization: `Bearer ${token}`, ...PROTOCOL });
        if (res.status !== 401 && !(route.auth === 'enroll' && res.status === 400) && !(route.auth === 'enroll' && res.status === 200)) reached.push(`${route.method} ${route.path}:${res.status}`);
      }
      expect(reached.map((entry) => entry.replace(/^GET /, 'POST ')).sort()).toEqual([
        'POST /runners/contact:200', 'POST /runners/rotate:200',
        'POST /worker/claim:200', 'POST /worker/end:200', 'POST /worker/lease:200', 'POST /worker/models:200', 'POST /worker/repository:200', 'POST /worker/steps:200',
      ]);
      for (const path of ['/runners/contact', '/runners/rotate']) {
        expect((await r.post(path, {}, { authorization: `Bearer ${member.token}`, ...PROTOCOL })).status).toBe(401);
      }
      expect((await r.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${token}`, ...PROTOCOL, [PROJECT_HEADER]: 'proj_1' })).status).toBe(401);
    } finally { r.e.sqlite.close(); }
  });
});

describe('capacity, pause and removal', () => {
  it('lets a runner hold one live attempt however many processes present its credential at once', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.queueTitling();
      await r.queueTitling();
      const answers = await Promise.all([r.claim(token), r.claim(token), r.claim(token)]);
      expect(answers.filter((answer) => answer.claimed === true)).toHaveLength(1);
      expect(r.row(`SELECT COUNT(*) AS n FROM agent_runs WHERE leased_runner_id = ? AND status = 'running'`, runnerId)).toEqual({ n: 1 });
      expect(r.row(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'queued'`)).toEqual({ n: 1 });
      // The claims that lost minted nothing.
      expect(r.row(`SELECT COUNT(*) AS n FROM member_credentials WHERE member_id = ?`, HARNESS_MEMBER_ID)).toEqual({ n: 1 });
    } finally { r.e.sqlite.close(); }
  });

  it('drains on pause: no new claim, while the held attempt renews and ends; resume takes work again', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.queueTitling();
      await r.queueTitling();
      const { run } = await r.claim(token);
      const paused = await r.json(r.asSession(`/api/runners/${runnerId}/pause`, {}));
      expect(paused).toMatchObject({ changed: true, runner: { state: 'paused' } });
      expect((await r.asSession(`/api/runners/${runnerId}/pause`, {}, MEMBER_SUB)).status).toBe(403);
      expect(await r.claim(token)).toMatchObject({ claimed: false, reason: 'paused' });
      expect(await r.json(r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId }))).toMatchObject({ held: true });
      expect(await r.json(r.asRunner(token, '/runners/contact', {}))).toMatchObject({ runner: { state: 'paused' } });
      expect(await r.json(r.asRunner(token, '/worker/end', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId, status: 'failed' }))).toMatchObject({ ended: true });
      expect(await r.json(r.asSession(`/api/runners/${runnerId}/resume`, {}))).toMatchObject({ changed: true, runner: { state: 'enabled' } });
      expect(await r.claim(token)).toMatchObject({ claimed: true });
      expect(r.e.sqlite.query('SELECT action, actor_member FROM runner_audit ORDER BY revision').all()).toEqual([
        { action: 'registered', actor_member: OWNER }, { action: 'paused', actor_member: OWNER }, { action: 'resumed', actor_member: OWNER },
      ]);
    } finally { r.e.sqlite.close(); }
  });

  it('ends every authority on removal: the runner credential, its lease, its run token\'s reads and writes and its step pages; the sweep requeues the work', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.queueTitling();
      const { run } = await r.claim(token);
      expect((await r.asRun(run.runToken, '', {}, 'tools/list')).result.tools.length).toBeGreaterThan(0);
      const removed = await r.json(r.asSession(`/api/runners/${runnerId}/remove`, {}));
      expect(removed).toMatchObject({ changed: true, runner: { state: 'removed' } });
      expect(r.row('SELECT credential_epoch, removed_at FROM runners')).toEqual({ credential_epoch: 2, removed_at: r.now() });
      expect(r.row(`SELECT COUNT(*) AS n FROM runner_credentials WHERE revoked_at IS NULL`)).toEqual({ n: 0 });
      for (const path of ['/worker/lease', '/worker/end', '/worker/steps', '/runners/contact', '/worker/claim']) {
        expect((await r.asRunner(token, path, { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId, status: 'completed' })).status).toBe(401);
      }
      expect((await r.asRun(run.runToken, '', {}, 'tools/list')).error?.data?.code).toBe('no_run');
      expect((await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', title: 'x', summary: 'y' })).error?.data?.code).toBe('no_run');
      expect(r.row('SELECT title FROM sessions WHERE session_id = ?', 's1')).toEqual({ title: null });
      // A removal is final.
      expect(await r.json(r.asSession(`/api/runners/${runnerId}/resume`, {}))).toMatchObject({ changed: false, runner: { state: 'removed' } });
      r.advance(WORKER_LEASE_MS + 1);
      expect(await expireLeases(r.e.serverEnv, r.now())).toBe(1);
      expect(r.row('SELECT status, leased_runner_id, leased_runner_credential_id, dispatched_by FROM agent_runs WHERE id = ?', run.id))
        .toEqual({ status: 'queued', leased_runner_id: null, leased_runner_credential_id: null, dispatched_by: null });
      expect(r.row('SELECT owner_kind, runner_id FROM agent_run_attempts WHERE run_id = ?', run.id)).toEqual({ owner_kind: 'runner', runner_id: runnerId });
    } finally { r.e.sqlite.close(); }
  });

  it('refuses a run token\'s read and write when its parent runner is removed between admission and execution', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.queueTitling();
      const { run } = await r.claim(token);
      const remove = () => r.e.sqlite.run(`UPDATE runners SET state = 'removed', removed_at = ?, credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?`, [r.now(), runnerId]);
      // The read: the pipeline admits the run, then the tool's own admission reads the run again.
      let reads = 0;
      r.arm((sql) => { if (/FROM agent_runs WHERE dispatched_by = \? AND status = 'running'/.test(sql) && ++reads === 2) remove(); });
      expect((await r.asRun(run.runToken, 'myco_run_sessions', { op: 'material', project: 'proj_1' })).result?.content?.[0]?.text).toBeUndefined();
      r.arm(undefined);
      // The write: the guarded batch's assertion reads the parent at the commit.
      const s = rig();
      try {
        const second = await s.register();
        await s.queueTitling();
        const held = await s.claim(second.token);
        s.arm((sql) => { if (/UPDATE sessions SET/.test(sql)) s.e.sqlite.run(`UPDATE runners SET state = 'removed', removed_at = ?, credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?`, [s.now(), second.runnerId]); });
        const written = await s.asRun(held.run.runToken, 'myco_run_sessions', { op: 'title', title: 'Too late', summary: 'never lands' });
        s.arm(undefined);
        expect(JSON.stringify(written)).not.toContain('"written":true');
        expect(s.row('SELECT title FROM sessions WHERE session_id = ?', 's1')).toEqual({ title: null });
      } finally { s.e.sqlite.close(); }
    } finally { r.e.sqlite.close(); }
  });

  it('commits a claim\'s credential, run, attempt, input and contact together, or none of them, when the runner is removed before the commit', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.queueTitling();
      r.arm((sql) => { if (/SET status = 'running', started_at = \?, dispatched_by = \?, leased_by = \?, leased_runner_id/.test(sql)) r.e.sqlite.run(`UPDATE runners SET state = 'removed', removed_at = ?, credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?`, [r.now(), runnerId]); });
      const refused = await r.asRunner(token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES });
      r.arm(undefined);
      expect(await refused.json()).toMatchObject({ persisted: false, code: 'refused' });
      expect(r.row(`SELECT status, dispatched_by, leased_runner_id FROM agent_runs WHERE task = 'title-summary'`)).toEqual({ status: 'queued', dispatched_by: null, leased_runner_id: null });
      expect(r.row('SELECT COUNT(*) AS n FROM member_credentials WHERE member_id = ?', HARNESS_MEMBER_ID)).toEqual({ n: 0 });
      expect(r.row('SELECT COUNT(*) AS n FROM agent_run_attempts')).toEqual({ n: 0 });
      expect(r.row(`SELECT last_reason FROM runner_contacts`)).not.toEqual({ last_reason: 'claimed' });

    } finally { r.e.sqlite.close(); }
  });

  it('refuses every write of the core claim under the runner write guard once the presenting credential is revoked', async () => {
    const r = rig();
    try {
      const { runnerId } = await r.register();
      await r.queueTitling();
      const credentialId = r.row('SELECT id FROM runner_credentials')!.id as string;
      r.e.sqlite.run(`UPDATE runner_credentials SET revoked_at = ?, revoked_by = 'test' WHERE id = ?`, [r.now(), credentialId]);
      const guarded = { ...r.e.serverEnv, db: runnerWriteStore(r.e.db, credentialId) };
      await expect(claimNextRun(guarded, { principal: { kind: 'runner', runnerId, credentialId, machineId: null }, harnesses: OFFERED, capabilities: WORKER_CAPABILITIES, now: r.now() }))
        .rejects.toBeInstanceOf(RunnerWriteRefused);
      expect(r.row(`SELECT status, dispatched_by FROM agent_runs WHERE task = 'title-summary'`)).toEqual({ status: 'queued', dispatched_by: null });
      expect(r.row('SELECT COUNT(*) AS n FROM member_credentials WHERE member_id = ?', HARNESS_MEMBER_ID)).toEqual({ n: 0 });
    } finally { r.e.sqlite.close(); }
  });
});

describe('rotation and replay', () => {
  it('binds a staged successor once, answers a lost reply with it, moves the lease at its first use, and ends the lineage on a replayed predecessor', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      expect(await r.json(r.asRunner(token, '/runners/rotate', { candidate: bearer() }))).toMatchObject({ persisted: true, rotated: false, code: 'refresh_too_early' });
      await r.queueTitling();
      const { run } = await r.claim(token);
      // Open the refresh window without letting the lease lapse.
      r.e.sqlite.run('UPDATE runner_credentials SET expires_at = ? WHERE runner_id = ?', [r.now() + RUNNER_TOKEN_REFRESH_WINDOW_MS / 2, runnerId]);
      const successor = bearer();
      const rotated = await r.json(r.asRunner(token, '/runners/rotate', { candidate: successor }));
      const predecessorId = String(r.row('SELECT id FROM runner_credentials WHERE predecessor_id IS NULL')!.id);
      const successorId = String(rotated.credentialId);
      expect(successorId).toMatch(/^rc_/);
      expect(successorId).not.toBe(predecessorId);
      expect(rotated).toMatchObject({ persisted: true, rotated: true });
      expect(await r.json(r.asRunner(token, '/runners/rotate', { candidate: successor }))).toEqual({ ...rotated, credentialId: successorId });
      expect(r.row('SELECT COUNT(*) AS n FROM runner_credentials')).toEqual({ n: 2 });
      // Its first use moves the live lease's attribution and retires the predecessor; the attempt stays the same.
      expect(await r.json(r.asRunner(successor, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId }))).toMatchObject({ held: true });
      expect(r.row('SELECT leased_runner_credential_id, dispatched_by FROM agent_runs WHERE id = ?', run.id)).toEqual({ leased_runner_credential_id: successorId, dispatched_by: run.attemptId });
      expect((await r.asRunner(token, '/worker/claim', {})).status).toBe(401);
      expect(r.row('SELECT credential_epoch, state FROM runners')).toEqual({ credential_epoch: 1, state: 'enabled' });
      // The superseded credential asking to rotate is a second holder: every credential of the runner ends.
      const replayed = await r.asRunner(token, '/runners/rotate', { candidate: bearer() });
      expect(replayed.status).toBe(401);
      expect(await replayed.json()).toMatchObject({ code: 'lineage_replayed' });
      expect(r.row('SELECT credential_epoch FROM runners')).toEqual({ credential_epoch: 2 });
      expect((await r.asRunner(successor, '/runners/contact', {})).status).toBe(401);
      expect((await r.asRun(run.runToken, '', {}, 'tools/list')).error?.data?.code).toBe('no_run');
      expect(r.row(`SELECT action FROM runner_audit WHERE action = 'lineage_replayed'`)).toEqual({ action: 'lineage_replayed' });
    } finally { r.e.sqlite.close(); }
  });
});

describe('Deployment isolation', () => {
  it('authenticates nothing across two Deployments holding identical runner, credential and run ids', async () => {
    const a = rig({ deploymentId: 'deployment-a' });
    const b = rig({ deploymentId: 'deployment-b' });
    try {
      const registered = await a.register('mini');
      const own = bearer();
      const credentialId = a.row('SELECT id FROM runner_credentials')!.id;
      b.e.sqlite.run(`INSERT INTO runners (id, name, created_at) VALUES (?, 'mini', ?)`, [registered.runnerId, NOW]);
      b.e.sqlite.run(`INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, lineage_root) VALUES (?, ?, ?, 1, ?, ?, ?)`,
        [credentialId, registered.runnerId, await sha256Hex(own), NOW, NOW + 86_400_000, credentialId]);
      await a.queueTitling();
      await b.queueTitling();
      for (const path of ['/runners/contact', '/worker/claim']) {
        expect((await b.asRunner(registered.token, path, {})).status).toBe(401);
        expect((await a.asRunner(own, path, {})).status).toBe(401);
      }
      expect(b.row(`SELECT status FROM agent_runs WHERE task = 'title-summary'`)).toEqual({ status: 'queued' });
      expect(await b.json(b.asRunner(own, '/runners/contact', {}))).toMatchObject({ runner: { id: registered.runnerId, deploymentId: 'deployment-b' } });
    } finally { a.e.sqlite.close(); b.e.sqlite.close(); }
  });
});

describe('the lease lifecycle of a runner', () => {
  it('requeues a lapsed runner lease with a fresh attempt, names the runner in the fleet, and files step pages only under that runner', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register('mini');
      await r.queueTitling();
      const first = (await r.claim(token)).run;
      const fleet = await readWorkerFleet(r.e.db, r.now());
      expect(fleet.find((row) => row.runner !== null)).toMatchObject({ credentialId: runnerId, runner: { id: runnerId, name: 'mini' }, busy: { runId: first.id }, eligible: true, recent: true });
      // A legacy worker presenting the same machine as the runner's attempt files nothing under it.
      const member = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'mini-1' }, r.now());
      r.e.sqlite.run(`UPDATE agent_run_attempts SET machine_id = 'mini-1' WHERE run_id = ?`, [first.id]);
      const page = { projectId: 'proj_1', runId: first.id, attemptId: first.attemptId, page: 0, pages: 1, total: 0, overflow: 0, unrecognized: { total: 0, shapes: {} }, steps: [] };
      expect(await r.json(r.post('/worker/steps', page, memberHeaders(member.token)))).toMatchObject({ persisted: true, stored: false });
      expect(await r.json(r.asRunner(token, '/worker/steps', page))).toMatchObject({ persisted: true, stored: true });

      r.advance(WORKER_LEASE_MS + 1);
      expect(await r.json(r.asRunner(token, '/worker/lease', { projectId: 'proj_1', runId: first.id, attemptId: first.attemptId }))).toMatchObject({ persisted: true, held: false });
      expect(await expireLeases(r.e.serverEnv, r.now())).toBe(1);
      const second = (await r.claim(token)).run;
      expect(second.id).toBe(first.id);
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(r.e.sqlite.query('SELECT owner_kind, runner_id FROM agent_run_attempts WHERE run_id = ? ORDER BY claimed_at').all(first.id))
        .toEqual([{ owner_kind: 'runner', runner_id: runnerId }, { owner_kind: 'runner', runner_id: runnerId }]);
      // The requeue retired the first attempt's run token with its lease: it authenticates nothing.
      expect(await r.asRun(first.runToken, '', {}, 'tools/list')).toEqual({ error: 'unauthorized' });
    } finally { r.e.sqlite.close(); }
  });

  it('expires pending registrations and drops runner reports on recovery, and revokes every runner credential on a fork', async () => {
    const r = rig();
    try {
      const { token } = await r.register();
      await r.json(r.asRunner(token, '/runners/contact', { machineId: 'mini-1' }));
      const pending = await r.start('next');
      await prepareRecoveredTenant(r.e.db, 'replacement', r.now());
      expect(r.row('SELECT COUNT(*) AS n FROM runner_contacts')).toEqual({ n: 0 });
      expect((await r.asSession('/api/device/approve-runner', { user_code: pending.user_code })).status).toBe(409);
      expect((await r.asRunner(token, '/runners/contact', {})).status).toBe(200);
      await prepareRecoveredTenant(r.e.db, 'fork', r.now());
      expect(r.row('SELECT COUNT(*) AS n FROM runner_credentials WHERE revoked_at IS NULL')).toEqual({ n: 0 });
      expect((await r.asRunner(token, '/runners/contact', {})).status).toBe(401);
    } finally { r.e.sqlite.close(); }
  });
});

describe('the guards that decide a runner\'s authority', () => {
  it('refuses one runner every operation on another runner\'s lease and attempt', async () => {
    const r = rig();
    try {
      const a = await r.register('mini');
      const b = await r.register('vm');
      await r.queueTitling();
      const { run } = await r.claim(a.token);
      const named = { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId };
      expect(await r.json(r.asRunner(b.token, '/worker/lease', named))).toMatchObject({ persisted: true, held: false });
      expect(await r.json(r.asRunner(b.token, '/worker/end', { ...named, status: 'completed' }))).toMatchObject({ persisted: true, ended: false });
      expect(await r.json(r.asRunner(b.token, '/worker/repository', named))).toMatchObject({ held: false });
      const page = { ...named, page: 0, pages: 1, total: 0, overflow: 0, unrecognized: { total: 0, shapes: {} }, steps: [] };
      expect(await r.json(r.asRunner(b.token, '/worker/steps', page))).toMatchObject({ persisted: true, stored: false });
      expect(r.row('SELECT status, leased_runner_id FROM agent_runs WHERE id = ?', run.id)).toEqual({ status: 'running', leased_runner_id: a.runnerId });
    } finally { r.e.sqlite.close(); }
  });

  it('authenticates an expired runner credential only on rotation inside its idle bound, and a credential of an older epoch nowhere', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      r.e.sqlite.run('UPDATE runner_credentials SET expires_at = ? WHERE runner_id = ?', [r.now() - 1, runnerId]);
      expect((await r.asRunner(token, '/runners/contact', {})).status).toBe(401);
      expect((await r.asRunner(token, '/worker/claim', {})).status).toBe(401);
      expect(await r.json(r.asRunner(token, '/runners/rotate', { candidate: bearer() }))).toMatchObject({ persisted: true, rotated: true });
      const fresh = rig();
      try {
        const lapsed = await fresh.register();
        fresh.e.sqlite.run('UPDATE runner_credentials SET expires_at = ?, issued_at = ? WHERE runner_id = ?', [fresh.now() - 1, fresh.now() - RUNNER_LINEAGE_IDLE_MS, lapsed.runnerId]);
        expect((await fresh.asRunner(lapsed.token, '/runners/rotate', { candidate: bearer() })).status).toBe(401);
        expect(fresh.row('SELECT COUNT(*) AS n FROM runner_credentials')).toEqual({ n: 1 });
      } finally { fresh.e.sqlite.close(); }
      const stale = rig();
      try {
        const moved = await stale.register();
        stale.e.sqlite.run('UPDATE runners SET credential_epoch = 2, revision = revision + 1 WHERE id = ?', [moved.runnerId]);
        expect(stale.row('SELECT revoked_at FROM runner_credentials')).toEqual({ revoked_at: null });
        expect((await stale.asRunner(moved.token, '/runners/contact', {})).status).toBe(401);
        expect((await stale.asRunner(moved.token, '/runners/rotate', { candidate: bearer() })).status).toBe(401);
      } finally { stale.e.sqlite.close(); }
    } finally { r.e.sqlite.close(); }
  });

  it('commits a registration only for a pending runner request and a live owner or administrator, whoever calls it', async () => {
    const r = rig();
    try {
      const nothing = () => ({ runners: r.row('SELECT COUNT(*) AS n FROM runners'), decided: r.row('SELECT COUNT(*) AS n FROM device_requests WHERE decision IS NOT NULL') });
      const asked = await r.start();
      const requestId = r.row('SELECT id FROM device_requests WHERE subject = ?', 'runner')!.id as string;
      expect(await registerRunner(r.e.db, MEMBER, requestId, 'h', r.now())).toBeNull();
      r.e.sqlite.run(`UPDATE members SET revoked_at = ?, revoked_by = ? WHERE id = ?`, [r.now(), FOREIGN_LINEAGE_REVOKER, ADMIN]);
      expect(await registerRunner(r.e.db, ADMIN, requestId, 'h', r.now())).toBeNull();
      expect(await registerRunner(r.e.db, OWNER, requestId, 'h', r.now() + DEVICE_TTL_MS)).toBeNull();
      const member = await r.json(r.post('/auth/device/start', { machineId: 'laptop_9', machineName: 'Laptop', os: 'darwin' }));
      const memberRequest = r.row('SELECT id FROM device_requests WHERE subject = ?', 'member')!.id as string;
      expect(await registerRunner(r.e.db, OWNER, memberRequest, 'h', r.now())).toBeNull();
      expect(nothing()).toEqual({ runners: { n: 0 }, decided: { n: 0 } });
      const registered = await registerRunner(r.e.db, OWNER, requestId, 'h', r.now());
      expect(registered?.runnerId).toMatch(/^rn_/);
      expect(await registerRunner(r.e.db, OWNER, requestId, 'h', r.now())).toBeNull();
      expect(nothing()).toEqual({ runners: { n: 1 }, decided: { n: 1 } });
      expect(member.user_code).toBeString();
      expect(asked.user_code).toBeString();
    } finally { r.e.sqlite.close(); }
  });

  it('lands nothing of a claim whose credential is revoked, expired or of an older epoch, or whose runner is paused or already busy, after admission and before the commit', async () => {
    for (const late of ['revoked', 'expired', 'epoch', 'paused', 'busy'] as const) {
      const r = rig();
      try {
        const { token, runnerId } = await r.register();
        await r.queueTitling();
        if (late === 'busy') await r.queueTitling();
        let busyRun: string | null = null;
        r.arm((sql) => {
          if (!/SET status = 'running', started_at = \?, dispatched_by = \?, leased_by = \?, leased_runner_id/.test(sql)) return;
          r.arm(undefined);
          if (late === 'revoked') r.e.sqlite.run(`UPDATE runner_credentials SET revoked_at = ?, revoked_by = 'test' WHERE runner_id = ?`, [r.now(), runnerId]);
          if (late === 'expired') r.e.sqlite.run(`UPDATE runner_credentials SET expires_at = 1 WHERE runner_id = ?`, [runnerId]);
          if (late === 'epoch') r.e.sqlite.run(`UPDATE runners SET credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?`, [runnerId]);
          if (late === 'paused') r.e.sqlite.run(`UPDATE runners SET state = 'paused', revision = revision + 1 WHERE id = ?`, [runnerId]);
          if (late === 'busy') {
            busyRun = String(r.row(`SELECT id FROM agent_runs WHERE status = 'queued' ORDER BY queued_at DESC LIMIT 1`)!.id);
            const credential = String(r.row('SELECT id FROM runner_credentials')!.id);
            r.e.sqlite.run(`UPDATE agent_runs SET status = 'running', leased_runner_id = ?, leased_runner_credential_id = ?, lease_expires_at = ?, started_at = ? WHERE id = ?`,
              [runnerId, credential, r.now() + WORKER_LEASE_MS, r.now(), busyRun]);
          }
        });
        const answered = await r.json(r.asRunner(token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES }));
        expect({ late, claimed: answered.claimed ?? false }).toEqual({ late, claimed: false });
        expect({ late, minted: r.row('SELECT COUNT(*) AS n FROM member_credentials WHERE member_id = ?', HARNESS_MEMBER_ID) }).toEqual({ late, minted: { n: 0 } });
        expect({ late, attempts: r.row('SELECT COUNT(*) AS n FROM agent_run_attempts') }).toEqual({ late, attempts: { n: 0 } });
        expect({ late, running: r.row(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running' AND id IS NOT ?`, busyRun) }).toEqual({ late, running: { n: 0 } });
      } finally { r.e.sqlite.close(); }
    }
  });
});

describe('the stored lease owner', () => {
  it('admits one owner class on a run, a runner lease only with that runner\'s credential, and an attempt keeps its owner', async () => {
    const r = rig();
    try {
      const a = await r.register('mini');
      const b = await r.register('vm');
      await r.queueTitling();
      const { run } = await r.claim(a.token);
      const otherCredential = r.row('SELECT id FROM runner_credentials WHERE runner_id = ?', b.runnerId)!.id;
      expect(() => r.e.sqlite.run(`UPDATE agent_runs SET leased_by = 'mt_x' WHERE id = ?`, [run.id])).toThrow(/one lease owner class/);
      expect(() => r.e.sqlite.run(`UPDATE agent_runs SET leased_runner_credential_id = ? WHERE id = ?`, [otherCredential, run.id])).toThrow(/one lease owner class/);
      expect(() => r.e.sqlite.run(`UPDATE agent_runs SET leased_runner_credential_id = NULL WHERE id = ?`, [run.id])).toThrow(/one lease owner class/);
      expect(() => r.e.sqlite.run(`UPDATE agent_run_attempts SET runner_id = ? WHERE run_id = ?`, [b.runnerId, run.id])).toThrow(/keeps the owner/);
      expect(() => r.e.sqlite.run(`UPDATE runners SET state = 'enabled' WHERE id = ?`, [a.runnerId])).not.toThrow();
      await r.json(r.asSession(`/api/runners/${a.runnerId}/remove`, {}));
      expect(() => r.e.sqlite.run(`UPDATE runners SET state = 'enabled' WHERE id = ?`, [a.runnerId])).toThrow(/stays removed/);
      expect(() => r.e.sqlite.run(`DELETE FROM runners WHERE id = ?`, [a.runnerId])).toThrow(/never deleted/);
    } finally { r.e.sqlite.close(); }
  });
});

describe('the review corrections', () => {
  it('commits no contact once the runner is removed between admission and the write, and answers the state the store holds', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      r.arm((sql) => {
        if (!/INSERT INTO runner_contacts/.test(sql)) return;
        r.arm(undefined);
        r.e.sqlite.run(`UPDATE runners SET state = 'removed', removed_at = ?, credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?`, [r.now(), runnerId]);
        r.e.sqlite.run(`UPDATE runner_credentials SET revoked_at = ?, revoked_by = 'test' WHERE runner_id = ?`, [r.now(), runnerId]);
      });
      expect(await r.json(r.asRunner(token, '/runners/contact', { machineId: 'revoked-machine' }))).toMatchObject({ persisted: false, code: 'refused' });
      expect(r.row('SELECT COUNT(*) AS n FROM runner_contacts WHERE machine_id = ?', 'revoked-machine')).toEqual({ n: 0 });
      // Paused after admission: the answer is the state the write left, not the one authentication read.
      const s = rig();
      try {
        const live = await s.register();
        s.arm((sql) => {
          if (!/INSERT INTO runner_contacts/.test(sql)) return;
          s.arm(undefined);
          s.e.sqlite.run(`UPDATE runners SET state = 'paused', revision = revision + 1 WHERE id = ?`, [live.runnerId]);
        });
        expect(await s.json(s.asRunner(live.token, '/runners/contact', {}))).toMatchObject({ persisted: true, runner: { state: 'paused' } });
      } finally { s.e.sqlite.close(); }
      // Rotation keeps its lapsed admission under the same guard.
      const t = rig();
      try {
        const lapsed = await t.register();
        t.e.sqlite.run('UPDATE runner_credentials SET expires_at = ? WHERE runner_id = ?', [t.now() - 1, lapsed.runnerId]);
        expect(await t.json(t.asRunner(lapsed.token, '/runners/rotate', { candidate: bearer() }))).toMatchObject({ persisted: true, rotated: true });
      } finally { t.e.sqlite.close(); }
    } finally { r.e.sqlite.close(); }
  });

  it('carries no approvable registration through a portable restore, into the same Deployment or another', async () => {
    const a = rig({ deploymentId: 'deployment-a' });
    const b = rig({ deploymentId: 'deployment-b' });
    try {
      const asked = await a.start('pending-backup');
      a.e.sqlite.run('UPDATE deployment_ownership SET member_id = NULL, revision = 0 WHERE id = 1');
      const saved = await createBackup(a.e.db, a.e.bucket, { producer: 'test', now: a.now() });
      const artifact = (await backupArtifact(a.e.db, a.e.bucket, saved.id))!;
      a.e.sqlite.run('UPDATE deployment_ownership SET member_id = ?, revision = 1 WHERE id = 1', [OWNER]);
      const request = a.row(`SELECT id FROM device_requests WHERE subject = 'runner'`)!.id;
      a.e.sqlite.run('DELETE FROM device_requests WHERE id = ?', [request]);
      await restoreArtifact(a.e.db, { text: artifact.text, authorization: { kind: 'recovery' }, now: a.now() });
      expect(a.row('SELECT decision, expires_at FROM device_requests WHERE id = ?', request)).toEqual({ decision: null, expires_at: a.now() });
      expect((await a.asSession('/api/device/approve-runner', { user_code: asked.user_code })).status).toBe(409);
      await restoreArtifact(b.e.db, { text: artifact.text, authorization: { kind: 'recovery' }, allowForeignLineage: true, now: b.now() });
      expect((await b.asSession('/api/device/approve-runner', { user_code: asked.user_code })).status).toBe(409);
      expect((await b.asRunner(asked.candidate, '/runners/contact', {})).status).toBe(401);
      expect({ a: a.row('SELECT COUNT(*) AS n FROM runners'), b: b.row('SELECT COUNT(*) AS n FROM runners') }).toEqual({ a: { n: 0 }, b: { n: 0 } });
    } finally { a.e.sqlite.close(); b.e.sqlite.close(); }
  });

  it('writes one receipt per transition: the losing control of a race records nothing', async () => {
    for (const control of ['pause', 'remove'] as const) {
      const r = rig();
      try {
        const { runnerId } = await r.register();
        const outcomes = await Promise.all([controlRunner(r.e.db, OWNER, runnerId, control, r.now()), controlRunner(r.e.db, ADMIN, runnerId, control, r.now())]);
        expect({ control, changed: outcomes.map((o) => o?.changed).sort() }).toEqual({ control, changed: [false, true] });
        const winner = outcomes[0]!.changed ? OWNER : ADMIN;
        const action = control === 'pause' ? 'paused' : 'removed';
        expect({ control, receipts: r.e.sqlite.query('SELECT actor_member, revision FROM runner_audit WHERE runner_id = ? AND action = ?').all(runnerId, action) })
          .toEqual({ control, receipts: [{ actor_member: winner, revision: 2 }] });
      } finally { r.e.sqlite.close(); }
    }
  });

  it('names the executor of every attempt, so a requeue keeps the runner that took the earlier one', async () => {
    const r = rig();
    try {
      const a = await r.register('first-runner');
      const b = await r.register('second-runner');
      await r.queueTitling();
      const first = (await r.claim(a.token)).run;
      r.advance(WORKER_LEASE_MS + 1);
      expect(await expireLeases(r.e.serverEnv, r.now())).toBe(1);
      expect((await r.claim(b.token)).run.id).toBe(first.id);
      r.advance(WORKER_LEASE_MS + 1);
      expect(await expireLeases(r.e.serverEnv, r.now())).toBe(1);
      const member = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'm_admin' }, r.now());
      expect(await r.json(r.post('/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES }, memberHeaders(member.token)))).toMatchObject({ claimed: true });
      const detail = (await getRunDetail(r.e.db, { projectId: 'proj_1' }, first.id, r.now(), OWNER))!;
      expect(detail.attempts.map((attempt) => attempt.executor)).toEqual([
        { kind: 'runner', runnerId: a.runnerId, name: 'first-runner' },
        { kind: 'runner', runnerId: b.runnerId, name: 'second-runner' },
        { kind: 'legacy-worker', memberId: ADMIN },
      ]);
    } finally { r.e.sqlite.close(); }
  });
});

describe('runner update commands', () => {
  const report = (at: number, lastResult?: Record<string, unknown>) => ({ channel: 'alpha', currentVersion: '2.0.0-alpha.2', latestVersion: '2.0.0-alpha.3', lastCheckAt: at, ...(lastResult === undefined ? {} : { lastResult }) });

  it('declares administration, refuses a member, audits each acceptance and delivers one command until its matching outcome', async () => {
    const route = ROUTES.find((entry) => entry.path === '/api/runners/{runnerId}/update');
    expect(route).toMatchObject({ auth: 'session', authority: 'admin', authorization: { resource: 'runner', action: 'admin' } });
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      const path = `/api/runners/${runnerId}/update`;
      expect((await r.asSession(path, {})).status).toBe(409);
      expect(await r.json(r.asRunner(token, '/runners/contact', { version: '2.0.0-alpha.2', update: report(r.now()) }))).toMatchObject({ persisted: true, updateRequest: null });
      expect((await r.asSession(path, {}, MEMBER_SUB)).status).toBe(403);
      expect(r.row('SELECT COUNT(*) AS n FROM runner_update_requests')).toEqual({ n: 0 });
      const asked = await r.json(r.asSession(path, {}, ADMIN_SUB));
      expect(asked).toMatchObject({ requested: true, updateRequest: { requestedAt: r.now() } });
      expect(await r.json(r.asSession(path, {}))).toEqual(asked);
      expect(r.row("SELECT COUNT(*) AS n FROM runner_update_audit WHERE action = 'requested'")).toEqual({ n: 2 });
      expect(r.row("SELECT actor_member FROM runner_update_audit WHERE action = 'requested'")).toEqual({ actor_member: ADMIN });
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: report(r.now()) }))).toMatchObject({ updateRequest: asked.updateRequest });
      const stale = { requestId: 'old-request', fromVersion: '2.0.0-alpha.2', toVersion: '2.0.0-alpha.3', result: 'refused', reason: 'launch probe failed', at: r.now() };
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: report(r.now(), stale) }))).toMatchObject({ updateRequest: asked.updateRequest });
      const completed = { ...stale, requestId: asked.updateRequest.id, result: 'updated' };
      const contact = { update: { ...report(r.now(), completed), currentVersion: '2.0.0-alpha.3' } };
      expect(await r.json(r.asRunner(token, '/runners/contact', contact))).toMatchObject({ persisted: true, updateRequest: null });
      expect(await r.json(r.asRunner(token, '/runners/contact', contact))).toMatchObject({ persisted: true, updateRequest: null });
      expect(r.row("SELECT COUNT(*) AS n FROM runner_update_audit WHERE action = 'reported' AND request_id = ?", asked.updateRequest.id)).toEqual({ n: 1 });
      const listed = await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'));
      expect(listed.runners[0]).toMatchObject({ connected: true, version: '2.0.0-alpha.3', channel: 'alpha', latestVersion: '2.0.0-alpha.3', lastCheckAt: r.now(), lastResult: completed, updateRequest: null });
    } finally { r.e.sqlite.close(); }
  });

  it('audits both concurrent administrators against one pending command and preserves each acceptance time', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.asRunner(token, '/runners/contact', { update: report(r.now()) });
      const path = `/api/runners/${runnerId}/update`;
      const accepted = await Promise.all([OWNER_SUB, ADMIN_SUB].map(async (actor) => r.json(r.asSession(path, {}, actor))));
      expect(accepted.every((reply) => reply.requested === true)).toBe(true);
      expect(accepted[0]!.updateRequest).toEqual(accepted[1]!.updateRequest);
      expect(r.row('SELECT COUNT(*) AS n FROM runner_update_requests')).toEqual({ n: 1 });
      const commandId = accepted[0]!.updateRequest.id;
      const receipts = r.e.sqlite.query("SELECT id, actor_member, request_id, at FROM runner_update_audit WHERE action = 'requested' ORDER BY actor_member").all() as Array<{ id: string; actor_member: string; request_id: string; at: number }>;
      expect(receipts.map(({ actor_member, request_id, at }) => ({ actor_member, request_id, at })))
        .toEqual([OWNER, ADMIN].sort().map(actor_member => ({ actor_member, request_id: commandId, at: r.now() })));
      expect(new Set(receipts.map(({ id }) => id)).size).toBe(2);
      r.advance(1000);
      const later = await r.json(r.asSession(path, {}, ADMIN_SUB));
      expect(later).toEqual(accepted[0]);
      expect(r.row("SELECT COUNT(*) AS n FROM runner_update_audit WHERE action = 'requested'")).toEqual({ n: 3 });
      expect(r.row("SELECT actor_member, request_id, at FROM runner_update_audit WHERE action = 'requested' AND at = ?", r.now()))
        .toEqual({ actor_member: ADMIN, request_id: commandId, at: r.now() });
    } finally { r.e.sqlite.close(); }
  });

  it('keeps a mid-run request pending while recording contact and a live lease', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      await r.asRunner(token, '/runners/contact', { update: report(r.now()) });
      await r.queueTitling();
      const claimed = await r.claim(token);
      expect(claimed.claimed).toBe(true);
      const asked = await r.json(r.asSession(`/api/runners/${runnerId}/update`, {}));
      expect(asked.requested).toBe(true);
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: report(r.now()) }))).toMatchObject({ updateRequest: asked.updateRequest });
      const fleet = await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'));
      expect(fleet.runners[0]).toMatchObject({ busy: { runId: claimed.run.id }, updateRequest: asked.updateRequest });
      expect(r.row('SELECT status FROM agent_runs WHERE id = ?', claimed.run.id)).toEqual({ status: 'running' });
    } finally { r.e.sqlite.close(); }
  });

  it('drops malformed update metadata without refusing contact, and refuses a demotion at commit', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      const bad = await r.json(r.asRunner(token, '/runners/contact', { update: { ...report(r.now()), channel: 'dev' } }));
      expect(bad).toMatchObject({ persisted: true });
      expect(r.row('SELECT COUNT(*) AS n FROM runner_update_reports')).toEqual({ n: 0 });
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: { ...report(r.now()), channel: { toString: {} } } }))).toMatchObject({ persisted: true });
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: { ...report(r.now()), updateState: { phase: { toString: {} }, since: r.now() } } }))).toMatchObject({ persisted: true });
      r.e.sqlite.run('DELETE FROM runner_update_reports');
      await r.asRunner(token, '/runners/contact', {});
      expect(await r.json(r.asSession(`/api/runners/${runnerId}/update`, {}))).toEqual({ error: 'unsupported_channel' });
      await r.asRunner(token, '/runners/contact', { update: { ...report(r.now()), channel: null, lastResult: { fromVersion: '2.0.0-alpha.2', toVersion: '2.0.0-alpha.2', result: 'refused', reason: 'Missing install marker', at: r.now() } } });
      expect(await r.json(r.asSession(`/api/runners/${runnerId}/update`, {}))).toEqual({ error: 'unsupported_channel' });
      await r.asRunner(token, '/runners/contact', { update: report(r.now()) });
      r.arm((sql) => { if (/INSERT OR IGNORE INTO runner_update_requests/.test(sql)) r.e.sqlite.run(`UPDATE members SET role = 'member' WHERE id = ?`, [ADMIN]); });
      expect((await r.asSession(`/api/runners/${runnerId}/update`, {}, ADMIN_SUB)).status).toBe(403);
      expect(r.row('SELECT COUNT(*) AS n FROM runner_update_requests')).toEqual({ n: 0 });
      expect(r.row("SELECT COUNT(*) AS n FROM runner_update_audit WHERE action = 'requested'")).toEqual({ n: 0 });
    } finally { r.e.sqlite.close(); }
  });

  it('sanitizes Unicode and code-point bounded reasons, dropping invalid results without blocking execution', async () => {
    const r = rig();
    const logs = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { token } = await r.register();
      const lastResult = { attemptId: 'attempt_1', fromVersion: '2.0.0-alpha.2', toVersion: '2.0.0-alpha.3', result: 'failed', reason: 'probe\u0085failed\u200bto\u2028launch ' + '😀'.repeat(512), at: r.now() };
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: report(r.now(), lastResult) }))).toMatchObject({ persisted: true });
      const listed = await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'));
      const reason = listed.runners[0].lastResult.reason;
      expect(reason).toStartWith('probe failed to launch ');
      expect(Array.from(reason)).toHaveLength(512);
      expect(reason).not.toMatch(/[\p{C}\p{Zl}\p{Zp}]/u);
      expect(await r.json(r.asRunner(token, '/runners/contact', { update: report(r.now(), { ...lastResult, at: 'invalid' }) }))).toMatchObject({ persisted: true });
      const retained = await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'));
      expect(retained.runners[0].lastResult).toEqual(listed.runners[0].lastResult);
      expect(logs.mock.calls.some(([line]) => String(line).includes('runner_update_metadata') && String(line).includes('lastResult'))).toBe(true);
      await r.queueTitling();
      expect(await r.claim(token)).toMatchObject({ claimed: true });
    } finally { logs.mockRestore(); r.e.sqlite.close(); }
  });

  it('deduplicates one attempted result across delivery timestamps and projects holds separately from legacy receipts', async () => {
    const r = rig();
    try {
      const { token, runnerId } = await r.register();
      const lastResult = { attemptId: 'attempt_stable', fromVersion: '2.0.0-alpha.2', toVersion: '2.0.0-alpha.3', result: 'rolled_back', reason: 'Health check failed', at: r.now() };
      const blockedVersion = { version: '2.0.0-alpha.3', until: r.now() + 3600000, reason: 'Health check failed' };
      const updateState = { phase: 'cleanup_pending', since: r.now(), reason: 'Guardian cleanup failed' };
      for (let retry = 0; retry < 2; retry++) {
        expect(await r.json(r.asRunner(token, '/runners/contact', { update: { ...report(r.now(), { ...lastResult, at: r.now() }), blockedVersion, updateState } }))).toMatchObject({ persisted: true });
        r.advance(1000);
      }
      expect(r.row("SELECT COUNT(*) AS n FROM runner_update_audit WHERE action = 'reported'")).toEqual({ n: 1 });
      expect((await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'))).runners[0]).toMatchObject({ lastResult: { attemptId: 'attempt_stable' }, blockedVersion, updateState });
      expect(await r.json(r.asSession(`/api/runners/${runnerId}/update`, {}))).toMatchObject({ requested: true, updateRequest: { clearBlock: true } });
      await r.asRunner(token, '/runners/contact', { update: report(r.now()) });
      expect((await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'))).runners[0]).toMatchObject({ lastResult: { attemptId: 'attempt_stable' }, blockedVersion: null, updateState: null });
      r.e.sqlite.run('UPDATE runner_update_reports SET last_result = ? WHERE runner_id = ?', [JSON.stringify(lastResult), runnerId]);
      expect((await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'))).runners[0]).toMatchObject({ lastResult, blockedVersion: null, updateState: null });
      await r.asRunner(token, '/runners/contact', { update: report(r.now(), { ...lastResult, at: lastResult.at - 1, reason: 'Stale receipt' }) });
      expect((await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'))).runners[0]).toMatchObject({ lastResult, blockedVersion: null, updateState: null });
    } finally { r.e.sqlite.close(); }
  });

  it('portable backups omit pending commands and replacement/fork recovery clear them while preserving receipts', async () => {
    for (const mode of ['replacement', 'fork'] as const) {
      const r = rig();
      try {
        const { token, runnerId } = await r.register();
        await r.asRunner(token, '/runners/contact', { update: report(r.now()) });
        await r.asSession(`/api/runners/${runnerId}/update`, {});
        r.e.sqlite.run('UPDATE deployment_ownership SET member_id = NULL, revision = 0 WHERE id = 1');
        const saved = await createBackup(r.e.db, r.e.bucket, { now: r.now(), producer: 'runner-update-test' });
        const artifact = (await backupArtifact(r.e.db, r.e.bucket, saved.id))!.text;
        expect(artifact).not.toContain('"t":"runner_update_requests"');
        expect(artifact).not.toContain('"t":"runner_update_reports"');
        expect(artifact).toContain('"t":"runner_update_audit"');
        const restored = rig({ deploymentId: `restore-${mode}` });
        try {
          await restoreArtifact(restored.e.db, { text: artifact, authorization: { kind: 'recovery' }, allowForeignLineage: true, now: r.now() });
          expect(restored.row('SELECT COUNT(*) AS n FROM runner_update_requests')).toEqual({ n: 0 });
          expect(restored.row('SELECT COUNT(*) AS n FROM runner_update_audit')).toEqual({ n: 1 });
        } finally { restored.e.sqlite.close(); }

        await prepareRecoveredTenant(r.e.db, mode, r.now());
        expect(r.row('SELECT COUNT(*) AS n FROM runner_update_requests')).toEqual({ n: 0 });
        expect(r.row('SELECT COUNT(*) AS n FROM runner_update_reports')).toEqual({ n: 0 });
        expect(r.row('SELECT COUNT(*) AS n FROM runner_update_audit')).toEqual({ n: 1 });
      } finally { r.e.sqlite.close(); }
    }
  });
});

it('runner inventory reports acknowledged offers and their observation time, preserving them across contact-only updates', async () => {
  const r = rig();
  try {
    const { token, runnerId } = await r.register();
    expect(await r.claim(token)).toMatchObject({ persisted: true, claimed: false });
    const observed = r.now();
    const listed = async () => (await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'))).runners.find((row: Json) => row.id === runnerId);
    expect(await listed()).toMatchObject({ offers: [{ id: 'claude-code', authenticated: true }], offersObservedAt: observed });
    r.advance(60_000);
    await r.asRunner(token, '/runners/contact');
    expect(await listed()).toMatchObject({ offers: [{ id: 'claude-code', authenticated: true }], offersObservedAt: observed, lastSeenAt: r.now() });
    r.advance(60_000);
    await r.claim(token);
    expect(await listed()).toMatchObject({ offers: [{ id: 'claude-code', authenticated: true }], offersObservedAt: r.now() });
  } finally { r.e.sqlite.close(); }
});

describe('shared runner fleet projection', () => {
  it('retains every registered display state and names a lease even without any contact', async () => {
    const r = rig();
    try {
      const never = await r.register('never-contacted');
      const idle = await r.register('idle');
      await r.asRunner(idle.token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES });
      const empty = await r.register('no-agent');
      await r.asRunner(empty.token, '/worker/claim', { harnesses: [], capabilities: WORKER_CAPABILITIES });
      const unknown = await r.register('unknown');
      await r.asRunner(unknown.token, '/runners/contact', {});
      const stale = await r.register('stale');
      await r.asRunner(stale.token, '/runners/contact', {});
      r.e.sqlite.run('UPDATE runner_contacts SET last_seen_at = ? WHERE runner_id = ?', [r.now() - WORKER_LEASE_MS - 1, stale.runnerId]);
      const settling = await r.register('settling');
      await r.asRunner(settling.token, '/runners/contact', { arch: 'arm64', availability: 'settling', readinessReason: 'Waiting to settle after waking.' });
      const removed = await r.register('removed');
      await r.asSession(`/api/runners/${removed.runnerId}/remove`, {});
      const busy = await r.register('busy');
      await r.queueTitling();
      const run = (await r.claim(busy.token)).run;
      r.e.sqlite.run('DELETE FROM runner_contacts WHERE runner_id = ?', [busy.runnerId]);
      const project = await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'));
      expect(project.runners).toHaveLength(8);
      const by = (id: string) => project.runners.find((row: Json) => row.id === id);
      for (const [runner, display] of [[never, 'Never contacted'], [idle, 'Online'], [empty, 'Not ready'], [unknown, 'Not ready'], [stale, 'Offline'], [settling, 'Not ready'], [removed, 'Removed'], [busy, 'Busy']] as const) expect(by(runner.runnerId).display).toBe(display);
      expect(by(busy.runnerId)).toMatchObject({ busy: { runId: run.id, task: 'title-summary', projectId: 'proj_1', leaseExpiresAt: run.leaseExpiresAt ?? r.now() + WORKER_LEASE_MS } });
      expect(by(settling.runnerId)).toMatchObject({ arch: 'arm64', readiness: { state: 'settling', observedAt: r.now() - 10000 } });
      expect(by(unknown.runnerId).offers).toBeNull();
      await r.asSession(`/api/runners/${busy.runnerId}/pause`, {});
      const paused = await r.json(r.asSession('/api/runners', {}, MEMBER_SUB, 'GET'));
      expect(paused.runners.find((row: Json) => row.id === busy.runnerId)).toMatchObject({ display: 'Paused', busy: { runId: run.id } });
      expect((await r.asRunner(busy.token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId })).status).toBe(200);
      const status = await r.json(r.asSession('/api/status', {}, MEMBER_SUB, 'GET'));
      expect(status.workers.fleet.find((row: Json) => row.runner?.id === busy.runnerId).runnerDetails.display).toBe('Paused');
    } finally { r.e.sqlite.close(); }
  });

  it('keeps last completed, failed and attempted work after credential replacement and contact pruning', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      await r.queueTitling();
      const completed = (await r.claim(runner.token)).run;
      r.e.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ?, lease_expires_at = NULL WHERE id = ?`, [r.now(), completed.id]);
      r.advance(1);
      await r.queueTitling();
      const failed = (await r.claim(runner.token)).run;
      r.e.sqlite.run(`UPDATE agent_runs SET status = 'failed', completed_at = ?, lease_expires_at = NULL WHERE id = ?`, [r.now(), failed.id]);
      const candidate = await r.start('mini', bearer(), true);
      expect(await r.json(r.asSession(`/api/runners/${runner.runnerId}/recredential`, { user_code: candidate.user_code }))).toEqual({ approved: true, runnerId: runner.runnerId });
      expect(await r.poll(candidate.device_code)).toMatchObject({ registered: true, runnerId: runner.runnerId, name: 'mini' });
      expect((await r.asRunner(runner.token, '/runners/contact')).status).toBe(401);
      r.advance(WORKER_CONTACT_RETENTION_MS + 1);
      await pruneWorkerContacts(r.e.db, r.now(), WORKER_CONTACT_RETENTION_MS, 100);
      const projection = await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'));
      expect(projection.runners).toHaveLength(1);
      expect(projection.runners[0]).toMatchObject({ display: 'Offline', awaitingReplacement: true, lastCompleted: { runId: completed.id }, lastFailed: { runId: failed.id }, lastAttempted: { runId: failed.id } });
      expect(r.row(`SELECT action, actor_member FROM runner_metadata_audit WHERE runner_id = ?`, runner.runnerId)).toEqual({ action: 'recredentialed', actor_member: OWNER });
    } finally { r.e.sqlite.close(); }
  });

  it('replacement invalidates transient reports and the old assignment while retaining attempt history', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      await r.asRunner(runner.token, '/runners/contact', { arch: 'arm64', availability: 'ready', update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now() } });
      await r.queueTitling();
      const run = (await r.claim(runner.token)).run;
      const replacement = await r.start('mini', bearer(), true);
      expect((await r.asSession(`/api/runners/${runner.runnerId}/recredential`, { user_code: replacement.user_code })).status).toBe(200);
      const listed = await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'));
      expect(listed.runners[0]).toMatchObject({ display: 'Offline', awaitingReplacement: true, busy: null, offers: null, arch: null, version: null, channel: null, models: [], lastAttempted: { runId: run.id } });
      expect((await r.asRunner(runner.token, '/worker/lease', { projectId: 'proj_1', runId: run.id, attemptId: run.attemptId })).status).toBe(401);
      await r.asRunner(replacement.candidate, '/runners/contact', { availability: 'ready', arch: 'arm64', update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now(), updateState: { phase: 'probation', since: r.now() } } });
      expect((await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'))).runners[0]).toMatchObject({ display: 'Not ready', readiness: { state: 'unknown' } });
      await r.asSession(`/api/runners/${runner.runnerId}/remove`, {});
      expect((await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'))).runners[0]).toMatchObject({ display: 'Removed', busy: null, lastAttempted: { runId: run.id } });
    } finally { r.e.sqlite.close(); }
  });

  it('reviews replacement requests and keeps the same identity through the CLI device approval path', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      const generic = await r.start('mini');
      expect((await r.asSession(`/api/runners/${runner.runnerId}/recredential`, { user_code: generic.user_code })).status).toBe(409);
      const wrong = await r.start('another-machine');
      expect((await r.asSession(`/api/runners/${runner.runnerId}/recredential`, { user_code: wrong.user_code })).status).toBe(409);
      expect(r.row('SELECT decision FROM device_requests WHERE user_hash = ?', await sha256Hex(wrong.user_code.replace('-', '')))).toEqual({ decision: null });
      const renamedRequest = await r.start('mini', bearer(), true);
      await r.asSession(`/api/runners/${runner.runnerId}/rename`, { name: 'renamed-mini' });
      expect((await r.asSession(`/api/runners/${runner.runnerId}/recredential`, { user_code: renamedRequest.user_code })).status).toBe(409);
      await r.asSession(`/api/runners/${runner.runnerId}/rename`, { name: 'mini' });
      const token = bearer();
      const pending = await r.json(r.post('/auth/runner/start', { name: 'mini', replace: true, machineId: 'replacement-mini', machineName: 'New mini', os: 'darwin', candidate: token }));
      expect(await r.json(r.asSession('/api/device/preview', { user_code: pending.user_code }))).toMatchObject({
        subject: 'runner', runnerName: 'mini', replacingRunnerId: runner.runnerId, machineName: 'New mini', os: 'darwin', ip: '192.0.2.10',
      });
      expect((await r.asSession('/api/device/approve-runner', { user_code: pending.user_code }, MEMBER_SUB)).status).toBe(403);
      expect(await r.json(r.asSession('/api/device/approve-runner', { user_code: pending.user_code }))).toMatchObject({ runnerId: runner.runnerId });
      r.advance(5000);
      expect(await r.poll(pending.device_code)).toMatchObject({ runnerId: runner.runnerId, name: 'mini' });
      expect(r.row('SELECT COUNT(*) AS n FROM runners')).toEqual({ n: 1 });
      expect((await r.asRunner(runner.token, '/runners/contact')).status).toBe(401);
      expect((await r.asRunner(token, '/runners/contact')).status).toBe(200);
    } finally { r.e.sqlite.close(); }
  });

  it('binds a renamed machine by identity and refuses another machine with the requested name', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      const other = await r.register('other');
      await r.asSession(`/api/runners/${runner.runnerId}/rename`, { name: 'renamed-mini' });
      const body = { name: 'renamed-mini', replace: true, runnerId: runner.runnerId, machineId: 'renamed-machine', machineName: 'Mini', os: 'darwin', candidate: bearer() };
      expect((await r.post('/auth/runner/start', { ...body, name: 'other' })).status).toBe(409);
      expect((await r.post('/auth/runner/start', { ...body, runnerId: other.runnerId })).status).toBe(409);
      await r.asSession(`/api/runners/${other.runnerId}/rename`, { name: 'renamed-mini' });
      expect((await r.post('/auth/runner/start', { ...body, runnerId: undefined })).status).toBe(409);
      const pending = await r.json(r.post('/auth/runner/start', body));
      expect(await r.json(r.asSession('/api/device/approve-runner', { user_code: pending.user_code }))).toMatchObject({ runnerId: runner.runnerId });
      r.advance(5000);
      expect(await r.poll(pending.device_code)).toMatchObject({ runnerId: runner.runnerId, name: 'renamed-mini' });
      expect(r.row('SELECT COUNT(*) AS n FROM runners')).toEqual({ n: 2 });
    } finally { r.e.sqlite.close(); }
  });

  it('restores replacement request targets after their runner parents and expires carried approval', async () => {
    const source = rig();
    const destination = rig({ deploymentId: 'restored-deployment' });
    try {
      const runner = await source.register();
      const pending = await source.start('mini', bearer(), true);
      source.e.sqlite.run('UPDATE deployment_ownership SET member_id = NULL, revision = 0 WHERE id = 1');
      const saved = await createBackup(source.e.db, source.e.bucket, { producer: 'replacement-target', now: source.now() });
      const artifact = (await backupArtifact(source.e.db, source.e.bucket, saved.id))!;
      await restoreArtifact(destination.e.db, { text: artifact.text, authorization: { kind: 'recovery' }, allowForeignLineage: true, now: source.now() });
      expect(destination.row('SELECT replacing_runner_id,expires_at FROM device_requests WHERE user_hash = ?', await sha256Hex(pending.user_code.replace('-', ''))))
        .toEqual({ replacing_runner_id: runner.runnerId, expires_at: source.now() });
      expect(destination.row('SELECT id FROM runners WHERE id = ?', runner.runnerId)).toEqual({ id: runner.runnerId });
      destination.at(source.now());
      expect((await destination.asSession('/api/device/approve-runner', { user_code: pending.user_code })).status).toBe(409);
    } finally { source.e.sqlite.close(); destination.e.sqlite.close(); }
  });

  it('keeps both runners claiming through malformed auxiliary update metadata over HTTP', async () => {
    const r = rig();
    try {
      const bad = await r.register('bad-update');
      await r.asRunner(bad.token, '/runners/contact', { update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now() } });
      r.e.sqlite.run(`UPDATE runner_update_reports SET last_result = '[1]' WHERE runner_id = ?`, [bad.runnerId]);
      await r.queueTitling();
      expect((await r.claim(bad.token)).claimed).toBe(true);
      const good = await r.register('good-update');
      await r.queueTitling();
      expect((await r.claim(good.token)).claimed).toBe(true);
      const runners = await r.json(r.asSession('/api/runners', {}, OWNER_SUB, 'GET'));
      expect(runners.runners.find((row: Json) => row.id === bad.runnerId)).toMatchObject({ updateMetadataUnavailable: true, updateState: null, display: 'Busy' });
      const status = await r.json(r.asSession('/api/status', {}, OWNER_SUB, 'GET'));
      expect(status.workers.available).toBe(true);
    } finally { r.e.sqlite.close(); }
  });

  it('keeps readiness observations monotonic and run history readable when fleet reads fail', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      await r.e.db.batch([runnerObservationStatement(r.e.db, runner.runnerId, { arch: 'arm64', state: 'ready', reason: 'Awake.' }, r.now())]);
      await r.e.db.batch([runnerObservationStatement(r.e.db, runner.runnerId, { arch: 'arm64', state: 'settling', reason: 'Waiting.' }, r.now() - 1)]);
      expect(r.row('SELECT availability,observed_at FROM runner_observations WHERE runner_id = ?', runner.runnerId)).toEqual({ availability: 'ready', observed_at: r.now() });
      await r.queueTitling();
      const id = String(r.row("SELECT id FROM agent_runs WHERE status = 'queued'")!.id);
      r.arm(sql => { if (sql.includes('LEFT JOIN runner_observations')) throw new Error('fleet read failed'); });
      const runs = await r.json(r.asSession('/api/projects/proj_1/runs', {}, OWNER_SUB, 'GET'));
      expect(JSON.stringify(runs)).toContain('"rows"');
      expect(runs.rows.find((row: Json) => row.id === id)).toMatchObject({ fleetWait: { reason: 'unavailable', observedAt: r.now() } });
      const detail = await r.json(r.asSession(`/api/projects/proj_1/runs/${id}`, {}, OWNER_SUB, 'GET'));
      expect(detail.run).toMatchObject({ id, fleetWait: { reason: 'unavailable' } });
    } finally { r.e.sqlite.close(); }
  });

  it('gives every control only to owner/admin and refuses revoked dashboard sessions', async () => {
    const r = rig();
    try {
      const runner = await r.register();
      await r.asRunner(runner.token, '/runners/contact', { update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now() } });
      const pending = await r.start('mini', bearer(), true);
      for (const action of ['rename', 'pause', 'resume', 'remove', 'recredential', 'update']) {
        const res = await r.asSession(`/api/runners/${runner.runnerId}/${action}`, action === 'rename' ? { name: 'renamed' } : action === 'recredential' ? { user_code: pending.user_code } : {}, MEMBER_SUB);
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'not_admin' });
      }
      await expect(renameRunner(r.e.db, MEMBER, runner.runnerId, 'forbidden', r.now())).rejects.toThrow();
      for (const sub of [OWNER_SUB, ADMIN_SUB]) {
        expect((await r.asSession(`/api/runners/${runner.runnerId}/rename`, { name: `name-${sub}` }, sub)).status).toBe(200);
        expect((await r.asSession(`/api/runners/${runner.runnerId}/pause`, {}, sub)).status).toBe(200);
        expect((await r.asSession(`/api/runners/${runner.runnerId}/resume`, {}, sub)).status).toBe(200);
      }
      expect(r.row(`SELECT COUNT(*) AS n FROM runner_metadata_audit WHERE action = 'renamed'`)).toEqual({ n: 2 });
      expect((await r.asSession(`/api/runners/${runner.runnerId}/rename`, { name: `name-${ADMIN_SUB}` }, ADMIN_SUB)).status).toBe(200);
      expect(r.row(`SELECT COUNT(*) AS n FROM runner_metadata_audit WHERE action = 'renamed'`)).toEqual({ n: 2 });
      r.e.sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [r.now(), MEMBER]);
      expect((await r.asSession('/api/runners', {}, MEMBER_SUB, 'GET')).status).toBeGreaterThanOrEqual(400);
      expect(r.row('SELECT name FROM runners WHERE id = ?', runner.runnerId)?.name).toBe(`name-${ADMIN_SUB}`);
    } finally { r.e.sqlite.close(); }
  });

  it('names whole-fleet queue reasons and retains queue age across capacity, readiness and limits', async () => {
    const r = rig();
    try {
      await r.queueTitling();
      const oldest = r.now();
      const read = () => readFleetProjection({ ...r.env, platform: { ...r.env.platform, name: 'bun' } }, r.now());
      expect((await read()).queue).toMatchObject({ count: 1, oldestAt: oldest, reasons: [{ reason: 'no_runner', count: 1 }] });
      const runner = await r.register();
      const first = (await r.claim(runner.token)).run;
      await r.queueTitling();
      expect((await read()).queue.reasons).toEqual([{ reason: 'capacity', count: 1 }]);
      const preview = await readTaskStartPreview(r.env, 'proj_1', 'title-summary', MEMBER, r.now());
      expect(preview.executions).toHaveLength(0);
      r.e.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ?, lease_expires_at = NULL WHERE id = ?`, [r.now(), first.id]);
      await r.asRunner(runner.token, '/runners/contact', { availability: 'settling', readinessReason: 'Waiting after waking.' });
      expect((await read()).queue.reasons).toEqual([{ reason: 'settling', count: 1 }]);
      await r.asRunner(runner.token, '/runners/contact', { availability: 'ready', readinessReason: 'Awake.' });
      await r.asSession(`/api/runners/${runner.runnerId}/pause`, {});
      expect((await read()).queue).toMatchObject({ reasons: [{ reason: 'paused', count: 1 }], nativeNeedsRunner: true });
      await r.asSession(`/api/runners/${runner.runnerId}/resume`, {});
      await r.asRunner(runner.token, '/runners/contact', { update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now(), updateState: { phase: 'probation', since: r.now() } } });
      expect((await read()).queue.reasons).toEqual([{ reason: 'updating', count: 1 }]);
      await r.asRunner(runner.token, '/runners/contact', { update: { channel: 'alpha', currentVersion: '2.0.0-alpha.3', latestVersion: null, lastCheckAt: r.now(), updateState: null } });
      r.e.sqlite.run(`UPDATE runner_contacts SET offers = '[]' WHERE runner_id = ?`, [runner.runnerId]);
      expect((await read()).queue.reasons).toEqual([{ reason: 'not_signed_in', count: 1 }]);
      r.e.sqlite.run(`UPDATE agent_runs SET task = 'canopy-map' WHERE status = 'queued'`);
      r.e.sqlite.run(`UPDATE runner_contacts SET capabilities = '[]' WHERE runner_id = ?`, [runner.runnerId]);
      expect((await read()).queue.reasons).toEqual([{ reason: 'model_profile', count: 1 }]);
      r.e.sqlite.run(`UPDATE runner_contacts SET capabilities = 'invalid' WHERE runner_id = ?`, [runner.runnerId]);
      expect((await read()).queue.reasons).toEqual([{ reason: 'unavailable', count: 1 }]);
      r.e.sqlite.run(`UPDATE agent_runs SET task = 'title-summary' WHERE status = 'queued'`);
      r.e.sqlite.run(`UPDATE runner_contacts SET capabilities = ? WHERE runner_id = ?`, [JSON.stringify(WORKER_CAPABILITIES), runner.runnerId]);
      r.e.sqlite.run(`UPDATE runner_contacts SET offers = 'invalid' WHERE runner_id = ?`, [runner.runnerId]);
      expect((await read()).queue.reasons).toEqual([{ reason: 'unavailable', count: 1 }]);
      r.e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES ('agent.limits.task_runs_per_hour','1',?,'test')`, [r.now()]);
      expect((await read()).queue.reasons).toEqual([{ reason: 'dispatch_ceiling', count: 1 }]);
      const plan = r.e.sqlite.query(`EXPLAIN QUERY PLAN SELECT task,held_by,COUNT(*),MIN(queued_at),MIN(id) FROM agent_runs INDEXED BY idx_fleet_queue WHERE status = 'queued' GROUP BY task,held_by`).all();
      expect(JSON.stringify(plan)).toContain('COVERING INDEX idx_fleet_queue');
      expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
    } finally { r.e.sqlite.close(); }
  });

  it('surfaces failed reads as unavailable, never an empty fleet or zero queue', async () => {
    const r = rig();
    try {
      await r.register();
      r.arm(sql => { if (sql.includes('LEFT JOIN runner_observations')) throw new Error('fleet read failed'); });
      expect((await r.asSession('/api/runners', {}, OWNER_SUB, 'GET')).status).toBe(503);
      const status = await r.json(r.asSession('/api/status', {}, OWNER_SUB, 'GET'));
      expect(status.workers).toMatchObject({ available: false, fleet: null, runsQueued: null, workersBusy: null });
      expect(status.unavailable).toContain('workers');
    } finally { r.e.sqlite.close(); }
  });
});

describe('forgetting a retired legacy worker', () => {
  it('forgets only an offline contact, audits the owner, preserves membership/capture and reappears on contact', async () => {
    const r = rig();
    try {
      const legacy = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'retired-laptop' }, r.now());
      const contact = () => recordWorkerContact(r.e.db, { credentialId: legacy.tokenId, machineId: 'retired-laptop', offers: OFFERED, capabilities: WORKER_CAPABILITIES, reason: 'no_work', now: r.now() });
      await contact();
      const path = `/api/workers/legacy/${legacy.tokenId}/forget`;
      expect((await r.asSession(path, {})).status).toBe(409);
      r.advance(WORKER_LEASE_MS + 1);
      expect((await r.asSession(path, {}, MEMBER_SUB)).status).toBeGreaterThanOrEqual(400);
      const before = r.row('SELECT * FROM member_credentials WHERE id = ?', legacy.tokenId);
      const member = r.row('SELECT * FROM members WHERE id = ?', ADMIN);
      expect(await r.json(r.asSession(path, {}))).toEqual({ forgotten: true });
      expect(r.row('SELECT * FROM member_credentials WHERE id = ?', legacy.tokenId)).toEqual(before);
      expect(r.row('SELECT * FROM members WHERE id = ?', ADMIN)).toEqual(member);
      for (const endpoint of ['/api/status', '/api/runners']) {
        const data = await r.json(r.asSession(endpoint, {}, OWNER_SUB, 'GET'));
        expect((endpoint === '/api/status' ? data.workers.fleet : data.legacyWorkers).some((row: Json) => row.credentialId === legacy.tokenId)).toBe(false);
      }
      expect(r.row('SELECT credential_id,actor_member,action FROM legacy_worker_audit')).toEqual({ credential_id: legacy.tokenId, actor_member: OWNER, action: 'forgotten' });
      expect((await r.asRunner(legacy.token, '/members/status', {})).status).toBe(200);
      await contact();
      expect((await readWorkerFleet(r.e.db, r.now())).some(row => row.credentialId === legacy.tokenId)).toBe(true);
    } finally { r.e.sqlite.close(); }
  });

  it('refuses forget under a live lease even if the contact is stale', async () => {
    const r = rig();
    try {
      const legacy = await issueMemberToken(r.e.db, { memberId: ADMIN, machineId: 'working-laptop' }, r.now());
      await r.queueTitling();
      await r.json(r.asRunner(legacy.token, '/worker/claim', { harnesses: OFFERED, capabilities: WORKER_CAPABILITIES }));
      r.e.sqlite.run('UPDATE worker_contacts SET last_seen_at = ? WHERE credential_id = ?', [r.now() - WORKER_LEASE_MS - 1, legacy.tokenId]);
      expect((await r.asSession(`/api/workers/legacy/${legacy.tokenId}/forget`, {}, ADMIN_SUB)).status).toBe(409);
      expect(r.row('SELECT COUNT(*) AS n FROM legacy_worker_audit')).toEqual({ n: 0 });
    } finally { r.e.sqlite.close(); }
  });
});
