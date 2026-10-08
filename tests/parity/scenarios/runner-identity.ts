import { expect } from 'bun:test';
import { FOREIGN_LINEAGE_REVOKER, PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { lit, MEMBER_ID, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

const ADMIN = 'mem_runner_parity_admin';
const ADMIN_SUB = '168911';
/** How far ahead another scenario's queued run is parked while this one claims, and back again afterwards. */
const PARK_MS = 3_600_000;

interface Started { device_code: string; user_code: string }

const bearer = (): string => `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

async function adminCookie(target: ParityTarget): Promise<Record<string, string>> {
  const now = Date.now();
  return { cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: ADMIN_SUB, login: 'runner-admin', iat: now, exp: now + 3600000 })}`, 'cf-connecting-ip': '1.2.3.4' };
}

function post(target: ParityTarget, path: string, body: unknown, headers: Record<string, string> = { 'cf-connecting-ip': '1.2.3.4' }): Promise<Response> {
  return fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const asRunner = (target: ParityTarget, token: string, path: string, body: unknown = {}) =>
  post(target, path, body, { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL), 'cf-connecting-ip': '1.2.3.4' });

/**
 * A runner registered through the device flow claims a run on its own credential and loses every authority on
 * removal, with each refusal leaving nothing behind — on the native entry over SQLite and on workerd over D1.
 */
export const runnerIdentity: ParityScenario = {
  name: 'runners: device registration, held and failing approvals leave nothing, a runner-only claim, and removal ending every authority',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const now = Date.now();
    await target.sql(`UPDATE deployment_ownership SET member_id = ${lit(MEMBER_ID)}, revision = revision + 1 WHERE id = 1`);
    await target.sql(`INSERT OR IGNORE INTO members(id,label,role,github_id,created_at) VALUES (${lit(ADMIN)},'Runner admin','admin',${lit(ADMIN_SUB)},${now})`);
    const admin = await adminCookie(target);
    const start = async (candidate: string, name = 'parity-mini'): Promise<Started> => {
      const response = await post(target, '/auth/runner/start', { name, machineId: `runner_${crypto.randomUUID()}`, machineName: 'Parity mini', os: 'linux', candidate });
      expect(response.status).toBe(200);
      return await response.json() as Started;
    };
    const approve = (started: Started, headers = admin) => post(target, '/api/device/approve-runner', { user_code: started.user_code }, headers);
    const count = async (table: string) => Number((await target.sql(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n);

    const token = bearer();
    const first = await start(token);
    const approved = await approve(first);
    expect(approved.status).toBe(200);
    const { runnerId } = await approved.json() as { runnerId: string };
    const answer = async (response: Promise<Response>) => await (await response).json() as Record<string, unknown>;
    expect(await answer(post(target, '/auth/runner/poll', { device_code: first.device_code }))).toMatchObject({ registered: true, runnerId, name: 'parity-mini' });
    expect(await answer(post(target, '/auth/device/poll', { device_code: first.device_code }))).toEqual({ error: 'invalid_grant' });
    expect(await answer(asRunner(target, token, '/runners/contact', { machineId: 'parity-mini' }))).toMatchObject({ persisted: true, runner: { id: runnerId, state: 'enabled' } });

    // A registration batch that fails at its credential leaves no runner, no decision and no audit on this store.
    const runners = await count('runners');
    const audits = await count('runner_audit');
    const clashing = bearer();
    const second = await start(clashing);
    await target.sql(`INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, lineage_root)
      VALUES ('rc_parity_clash', ${lit(runnerId)}, ${lit(await sha256Hex(clashing))}, 1, ${now}, ${now + 60_000}, 'rc_parity_clash')`);
    expect((await approve(second)).status).toBe(409);
    expect(await count('runners')).toBe(runners);
    expect(await count('runner_audit')).toBe(audits);
    expect(await target.sql(`SELECT decision FROM device_requests WHERE candidate_hash = ${lit(await sha256Hex(clashing))}`)).toEqual([{ decision: null }]);
    await target.sql(`UPDATE runner_credentials SET revoked_at = ${now}, revoked_by = 'parity' WHERE id = 'rc_parity_clash'`);

    // A held administrator approves nothing.
    const third = await start(bearer());
    await target.sql(`UPDATE members SET revoked_at = ${now}, revoked_by = ${lit(FOREIGN_LINEAGE_REVOKER)} WHERE id = ${lit(ADMIN)}`);
    expect((await approve(third)).status).toBe(401);
    expect(await count('runners')).toBe(runners);

    // The runner claims a queued run on its own credential and is handed no stored login.
    const parked = (await target.sql(`SELECT id FROM agent_runs WHERE status = 'queued' AND dispatched_by IS NULL AND task IS NOT NULL`)).map((r) => String(r.id));
    const shiftParked = async (by: number) => {
      if (parked.length > 0) await target.sql(`UPDATE agent_runs SET queued_at = queued_at + (${by}) WHERE id IN (${parked.map(lit).join(', ')})`);
    };
    await shiftParked(PARK_MS);
    const runId = `run_parity_runner_${now}`;
    const sessionId = `sess_parity_runner_${now}`;
    try {
      await target.sql(`INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (${lit(target.projectId)}, 'Runner parity', ${now})`);
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
      await target.sql(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES (${lit(target.projectId)}, ${lit(sessionId)}, 'm_parity', 'tok_parity', ${now}, ${now})`);
      await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
        VALUES (${lit(target.projectId)}, ${lit(runId)}, 'myco-agent', 'title-summary', 'queued', ${now - PARK_MS}, 'worker',
          ${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, timeoutSeconds: 120, params: { session_id: sessionId, mode: 'claim' } }))},
          ${lit(JSON.stringify({ timeoutSeconds: 120, session_id: sessionId, mode: 'claim' }))}, NULL)`);
      const claimed = await (await asRunner(target, token, '/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES })).json() as Record<string, any>;
      expect({ claimed: claimed.claimed, runId: claimed.run?.id, credentialEnv: claimed.run?.credentialEnv }).toEqual({ claimed: true, runId, credentialEnv: {} });
      expect(await target.sql(`SELECT leased_by, leased_runner_id FROM agent_runs WHERE id = ${lit(runId)}`)).toEqual([{ leased_by: null, leased_runner_id: runnerId }]);
      expect(await target.sql(`SELECT owner_kind, runner_id FROM agent_run_attempts WHERE run_id = ${lit(runId)}`)).toEqual([{ owner_kind: 'runner', runner_id: runnerId }]);
      const mcp = async () => await (await post(target, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: `Bearer ${claimed.run.runToken}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL), [PROJECT_HEADER]: target.projectId, 'cf-connecting-ip': '1.2.3.4' })).json() as Record<string, any>;
      expect((await mcp()).result?.tools?.length).toBeGreaterThan(0);

      // Removal ends the runner credential, its lease and its run token's reads at once.
      const removed = await post(target, `/api/runners/${runnerId}/remove`, {}, target.ownerHeaders());
      expect(await removed.json()).toMatchObject({ changed: true, runner: { state: 'removed' } });
      expect((await asRunner(target, token, '/worker/lease', { projectId: target.projectId, runId, attemptId: claimed.run.attemptId })).status).toBe(401);
      expect((await mcp()).error?.data?.code).toBe('no_run');
      expect(await target.sql(`SELECT COUNT(*) AS n FROM runner_credentials WHERE runner_id = ${lit(runnerId)} AND revoked_at IS NULL`)).toEqual([{ n: 0 }]);
    } finally {
      await target.sql(`UPDATE agent_runs SET status = 'failed', completed_at = ${Date.now()}, lease_expires_at = NULL WHERE id = ${lit(runId)}`);
      await target.sql(`UPDATE members SET revoked_at = NULL, revoked_by = NULL WHERE id = ${lit(ADMIN)}`);
      await shiftParked(-PARK_MS);
    }
  },
};
