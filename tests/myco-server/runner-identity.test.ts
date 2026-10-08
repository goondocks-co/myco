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
import { describe, expect, it } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID, PROJECT_HEADER, WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { DEVICE_TTL_MS } from '@myco-server-worker/auth/device.js';
import { RUNNER_TOKEN_REFRESH_WINDOW_MS } from '@myco-server-worker/auth/runners.js';
import { claimNextRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { workerLiveness } from '@myco-server-worker/core/runs.js';
import { readWorkerFleet } from '@myco-server-worker/core/worker-contacts.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { prepareRecoveredTenant } from '@myco-server-worker/core/recovered-tenant.js';
import { registerRunner, runnerWriteStore, RunnerWriteRefused, RUNNER_LINEAGE_IDLE_MS } from '@myco-server-worker/auth/runners.js';
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
  const start = async (name = 'mini', candidate = bearer()): Promise<Json> => ({ candidate, ...await json(post('/auth/runner/start', { name, machineId: `rm_${crypto.randomUUID()}`, machineName: 'Mac mini', os: 'darwin', candidate })) });
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

describe('runner registration through the device flow', () => {
  it('names the runner on the approval, binds the client\'s candidate at the approval, and mints nothing at the poll', async () => {
    const r = rig();
    try {
      const started = await r.start('homelab-mini');
      expect(started).toMatchObject({ verification_uri: 'https://s/device', interval: 5 });
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
