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

    const update = { channel: 'alpha', currentVersion: '2.0.0-alpha.2', latestVersion: '2.0.0-alpha.3', lastCheckAt: now };
    expect(await answer(asRunner(target, token, '/runners/contact', { update }))).toMatchObject({ persisted: true, updateRequest: null });
    await target.sql(`UPDATE members SET role = 'member' WHERE id = ${lit(ADMIN)}`);
    expect((await post(target, `/api/runners/${runnerId}/update`, {}, admin)).status).toBe(403);
    await target.sql(`UPDATE members SET role = 'admin' WHERE id = ${lit(ADMIN)}`);
    const accepted = await Promise.all([admin, target.ownerHeaders()].map((headers) => answer(post(target, `/api/runners/${runnerId}/update`, {}, headers))));
    expect(accepted.every((reply) => reply.requested === true)).toBe(true);
    const updateRequest = accepted[0]!.updateRequest as { id: string; requestedAt: number };
    expect(accepted[1]!.updateRequest).toEqual(updateRequest);
    expect(await target.sql(`SELECT actor_member, COUNT(*) AS n FROM runner_update_audit
      WHERE action = 'requested' AND request_id = ${lit(updateRequest.id)} GROUP BY actor_member ORDER BY actor_member`))
      .toEqual([ADMIN, MEMBER_ID].sort().map(actor_member => ({ actor_member, n: 1 })));
    expect(await answer(asRunner(target, token, '/runners/contact', { update }))).toMatchObject({ updateRequest });
    const lastResult = { requestId: updateRequest.id, fromVersion: update.currentVersion, toVersion: update.latestVersion, result: 'updated', at: now };
    const updated = { update: { ...update, currentVersion: update.latestVersion, lastResult } };
    for (let retry = 0; retry < 2; retry++) expect(await answer(asRunner(target, token, '/runners/contact', updated))).toMatchObject({ updateRequest: null });
    expect(await target.sql(`SELECT COUNT(*) AS n FROM runner_update_audit WHERE request_id = ${lit(updateRequest.id)}`)).toEqual([{ n: 3 }]);
    expect(await target.sql(`SELECT current_version, channel FROM runner_update_reports WHERE runner_id = ${lit(runnerId)}`)).toEqual([{ current_version: update.latestVersion, channel: 'alpha' }]);

    const legacyId = 'mt_runner_inventory_parity';
    const legacyToken = 'runner-inventory-parity-member'.padEnd(43, 'x');
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at)
      VALUES (${lit(legacyId)}, ${lit(ADMIN)}, 'legacy-parity', ${lit(await sha256Hex(legacyToken))}, ${now}, ${now + PARK_MS}, ${lit(legacyId)}, ${now})`);
    await target.sql(`INSERT INTO worker_contacts (credential_id,machine_id,offers,capabilities,last_reason,last_seen_at,updated_at)
      VALUES (${lit(legacyId)},'legacy-parity','[]','[]','no_work',${now - 31 * 24 * 60 * 60 * 1000},${now})`);
    try {
      await target.clockWake();
      expect(await target.sql(`SELECT credential_id FROM worker_contacts WHERE credential_id = ${lit(legacyId)}`)).toEqual([{ credential_id: legacyId }]);
      await target.sql(`INSERT OR IGNORE INTO projects(project_id, name, created_at) VALUES (${lit(target.projectId)}, 'Runner parity', ${now})`);
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
      await target.sql(`INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at, dispatched_by)
        VALUES ('run_legacy_inventory_parity', ${lit(target.projectId)}, 'myco-agent', 'title-summary', 'running', ${now}, ${now}, ${lit(legacyId)}, ${now + PARK_MS}, NULL)`);
      const response = await fetch(`${target.url}/api/workers/legacy`, { headers: admin });
      expect(response.status).toBe(200);
      const inventory = await response.json() as { workers: Array<{ credentialId: string; runner: unknown; lastSeenAt: number }> };
      expect(inventory.workers.find((worker) => worker.credentialId === legacyId)).toMatchObject({ runner: null, lastSeenAt: now - 31 * 24 * 60 * 60 * 1000, busy: { runId: 'run_legacy_inventory_parity', leaseExpiresAt: now + PARK_MS } });
      expect(inventory.workers.some((worker) => worker.runner != null)).toBe(false);
      expect((await fetch(`${target.url}/api/workers/legacy`, { headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL), 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(401);
    } finally {
      await target.sql(`DELETE FROM agent_runs WHERE id = 'run_legacy_inventory_parity'`);
      await target.sql(`DELETE FROM worker_contacts WHERE credential_id = ${lit(legacyId)}`);
      await target.sql(`DELETE FROM member_credentials WHERE id = ${lit(legacyId)}`);
    }

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

      // Two owner pauses at once write one receipt, and a guarded contact answers the state the store holds.
      const paused = await Promise.all([1, 2].map(async () => (await post(target, `/api/runners/${runnerId}/pause`, {}, target.ownerHeaders())).json() as Promise<Record<string, any>>));
      expect(paused.map((answer) => answer.changed).sort()).toEqual([false, true]);
      expect(await target.sql(`SELECT COUNT(*) AS n FROM runner_audit WHERE runner_id = ${lit(runnerId)} AND action = 'paused'`)).toEqual([{ n: 1 }]);
      expect(await answer(asRunner(target, token, '/runners/contact', { machineId: 'parity-mini-2' }))).toMatchObject({ persisted: true, runner: { state: 'paused' } });
      expect(await target.sql(`SELECT machine_id FROM runner_contacts WHERE runner_id = ${lit(runnerId)}`)).toEqual([{ machine_id: 'parity-mini-2' }]);

      // Removal ends the runner credential, its lease and its run token's reads at once.
      const removed = await post(target, `/api/runners/${runnerId}/remove`, {}, target.ownerHeaders());
      expect(await removed.json()).toMatchObject({ changed: true, runner: { state: 'removed' } });
      expect((await asRunner(target, token, '/worker/lease', { projectId: target.projectId, runId, attemptId: claimed.run.attemptId })).status).toBe(401);
      expect((await mcp()).error?.data?.code).toBe('no_run');
      expect(await target.sql(`SELECT COUNT(*) AS n FROM runner_credentials WHERE runner_id = ${lit(runnerId)} AND revoked_at IS NULL`)).toEqual([{ n: 0 }]);
      expect((await asRunner(target, token, '/runners/contact', { machineId: 'parity-removed' })).status).toBe(401);
      expect(await target.sql(`SELECT machine_id FROM runner_contacts WHERE runner_id = ${lit(runnerId)}`)).toEqual([{ machine_id: 'parity-mini-2' }]);

      // A pending runner registration a portable restore carries arrives expired: no owner can approve it here.
      const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => 'BCDFGHJKLMNPQRSTVWXYZ23456789'[byte % 29]).join('');
      const meta = await target.sql(`SELECT key, value FROM schema_meta WHERE key IN ('deployment_id', 'version')`);
      const carriedAt = Date.now();
      const artifact = [
        { format: 'myco-backup/1', deploymentId: meta.find((row) => row.key === 'deployment_id')!.value, schemaVersion: Number(meta.find((row) => row.key === 'version')!.value), createdAt: carriedAt, producer: 'parity', counts: { device_requests: 1 } },
        { t: 'device_requests', r: {
          id: `en_device_carried_${carriedAt}`, device_hash: await sha256Hex(bearer()), user_hash: await sha256Hex(code), machine_id: 'carried', machine_name: 'Carried', os: 'linux',
          source_ip: '1.2.3.4', created_at: carriedAt, expires_at: carriedAt + 600_000, interval_seconds: 5, next_poll_at: carriedAt, slowed: 0,
          decision: null, decided_by: null, decided_at: null, subject: 'runner', runner_name: 'carried', candidate_hash: await sha256Hex(bearer()) } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n';
      const restored = await post(target, '/api/backups/restore-upload', { artifact }, target.ownerHeaders());
      expect(restored.status).toBe(200);
      const [carried] = await target.sql(`SELECT expires_at FROM device_requests WHERE id = ${lit(`en_device_carried_${carriedAt}`)}`) as Array<{ expires_at: number }>;
      expect(carried!.expires_at).toBeLessThanOrEqual(Date.now());
      expect((await post(target, '/api/device/approve-runner', { user_code: `${code.slice(0, 4)}-${code.slice(4)}` }, target.ownerHeaders())).status).toBe(409);
    } finally {
      await target.sql(`UPDATE agent_runs SET status = 'failed', completed_at = ${Date.now()}, lease_expires_at = NULL WHERE id = ${lit(runId)}`);
      await target.sql(`UPDATE members SET revoked_at = NULL, revoked_by = NULL WHERE id = ${lit(ADMIN)}`);
      await shiftParked(-PARK_MS);
    }
  },
};
