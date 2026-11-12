import { expect } from 'bun:test';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { ageRows, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { assignRole, browser, client, deviceMachine, person, runnerBearer, selectOwner, stopMember, type Person } from '../clients/identity.ts';
import { allowWorkerClaims } from '../clients/requests.ts';
import { askTitle, captureSession, runDetail } from '../clients/runs.ts';

const ADMIN_SUB = '168911';
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long ago a stale contact was last seen. */
const PARK_MS = 3_600_000;

interface Started { device_code: string; user_code: string }

/** The owner selected, and an administrator the owner invited and linked: the one who approves runners here. */
async function runnerAdmin(target: ParityTarget): Promise<Person> {
  await selectOwner(target);
  return person(target, ADMIN_SUB, { role: 'admin', login: 'runner-admin' });
}

/** A runner's registration request, waiting for an administrator's approval. */
async function start(target: ParityTarget, candidate: string, name = 'parity-mini', machineId = `runner_${crypto.randomUUID()}`, replace = false): Promise<Started> {
  const response = await client(target, '/auth/runner/start', { name, machineId, machineName: name, os: 'linux', candidate, ...(replace ? { replace } : {}) });
  expect(response.status).toBe(200);
  return response.body as Started;
}

/** A member machine's worker asking for work on its member credential, as a worker built before runners does. */
async function legacyClaim(target: ParityTarget, token: string): Promise<any> {
  const response = await fetch(`${target.url}/worker/claim`, {
    method: 'POST', headers: { ...memberHeadersFor(token, target.projectId), 'content-type': 'application/json' },
    body: JSON.stringify({ harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

/**
 * A runner registered through the device flow claims a run on its own credential and loses every authority on
 * removal, with each refusal leaving nothing behind — on the native entry over SQLite and on workerd over D1.
 */
export const runnerIdentity: ParityScenario = {
  name: 'runners: device registration, a demoted approver and a reused candidate refused, a runner-only claim, and removal ending every authority',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const now = Date.now();
    const admin = await runnerAdmin(target);
    const approve = (started: Started, session = admin.session) => browser(target, '/api/device/approve-runner', session, { user_code: started.user_code });
    const asRunner = (token: string, path: string, body: unknown = {}) => client(target, path, body, token);
    const fleet = async () => {
      const listed = await browser(target, '/api/runners', admin.session);
      expect(listed.status).toBe(200);
      return listed.body as { runners: Array<Record<string, unknown>> };
    };

    const token = runnerBearer();
    const first = await start(target, token);
    const approved = await approve(first);
    expect(approved.status).toBe(200);
    const { runnerId } = approved.body as { runnerId: string };
    expect((await client(target, '/auth/runner/poll', { device_code: first.device_code })).body).toMatchObject({ registered: true, runnerId, name: 'parity-mini' });
    expect((await client(target, '/auth/device/poll', { device_code: first.device_code })).body).toEqual({ error: 'invalid_grant' });
    expect((await asRunner(token, '/runners/contact', { machineId: 'parity-mini' })).body).toMatchObject({ persisted: true, runner: { id: runnerId, state: 'enabled' } });

    expect((await asRunner(token, '/runners/contact', { update: { channel: 'invalid' } })).body).toMatchObject({ persisted: true });
    const update = { observedOrder: 1, channel: 'alpha', currentVersion: '2.0.0-alpha.2', latestVersion: '2.0.0-alpha.3', lastCheckAt: now };
    const blockedVersion = { version: update.latestVersion, until: now + 3600000, reason: 'Launch failed' };
    expect((await asRunner(token, '/runners/contact', { update: { ...update, blockedVersion } })).body).toMatchObject({ persisted: true, updateRequest: null });
    expect((await fleet()).runners.find(runner => runner.id === runnerId)).toMatchObject({ blockedVersion, updateState: null });
    // A demoted administrator asks for no update; promoted again, it and the owner ask for the same one.
    expect((await assignRole(target, admin.id, 'member')).status).toBe(200);
    expect((await browser(target, `/api/runners/${runnerId}/update`, admin.session, {})).status).toBe(403);
    expect((await assignRole(target, admin.id, 'admin')).status).toBe(200);
    const accepted = await Promise.all([admin.session, target.ownerHeaders()].map(async (session) => (await browser(target, `/api/runners/${runnerId}/update`, session, {})).body as Record<string, unknown>));
    expect(accepted.every((reply) => reply.requested === true)).toBe(true);
    const updateRequest = accepted[0]!.updateRequest as { id: string; requestedAt: number };
    expect(accepted[1]!.updateRequest).toEqual(updateRequest);
    expect(updateRequest).toMatchObject({ clearBlock: true });
    expect((await asRunner(token, '/runners/contact', { update })).body).toMatchObject({ updateRequest });
    const lastResult = { requestId: updateRequest.id, attemptId: 'parity_update_attempt', fromVersion: update.currentVersion, toVersion: update.latestVersion, result: 'updated', at: now };
    const updateState = { phase: 'probation', since: now, reason: 'Waiting for health' };
    const updated = { update: { ...update, observedOrder: 2, currentVersion: update.latestVersion, lastResult, updateState } };
    for (let retry = 0; retry < 2; retry++) expect((await asRunner(token, '/runners/contact', { update: { ...updated.update, lastResult: { ...lastResult, at: now + retry, reason: 'probe\u0085failed​to launch ' + '😀'.repeat(512) } } })).body).toMatchObject({ persisted: true, updateRequest: null });
    expect((await asRunner(token, '/runners/contact', { update: { ...updated.update, lastResult: { ...lastResult, at: 'invalid' } } })).body).toMatchObject({ persisted: true });
    const projected = (await fleet()).runners.find(runner => runner.id === runnerId)!;
    expect(projected).toMatchObject({ blockedVersion: null, updateState, lastResult: { attemptId: 'parity_update_attempt' }, version: update.latestVersion, channel: 'alpha' });
    const reason = (projected.lastResult as { reason: string }).reason;
    expect(Array.from(reason)).toHaveLength(512);
    expect(reason).not.toMatch(/[\p{C}\p{Zl}\p{Zp}]/u);

    // A machine of the administrator still works as a legacy worker: it claims a run on its member credential.
    await allowWorkerClaims(target);
    const legacy = await deviceMachine(target, admin.session, 'legacy-parity');
    await captureSession(target, 'sess_legacy_inventory', 'Title the legacy worker run');
    const legacyRunId = await askTitle(target, 'sess_legacy_inventory');
    const legacyRun = await legacyClaim(target, legacy.token);
    expect({ claimed: legacyRun.claimed, runId: legacyRun.run?.id }).toEqual({ claimed: true, runId: legacyRunId });
    // Its contact is past its 30 days, and stays while the live lease still names it.
    await ageRows(target, { table: 'worker_contacts', column: 'last_seen_at', byMs: 31 * DAY_MS, match: { credential_id: legacy.tokenId } });
    await target.clockWake();
    const inventory = await browser(target, '/api/workers/legacy', admin.session);
    expect(inventory.status).toBe(200);
    const workers = inventory.body.workers as Array<{ credentialId: string; runner: unknown; lastSeenAt: number }>;
    const leaseExpiresAt = (await runDetail(target, legacyRunId)).run.leaseExpiresAt;
    expect(workers.find((worker) => worker.credentialId === legacy.tokenId)).toMatchObject({ runner: null, busy: { runId: legacyRunId, leaseExpiresAt } });
    expect(workers.find((worker) => worker.credentialId === legacy.tokenId)!.lastSeenAt).toBeLessThanOrEqual(Date.now() - 31 * DAY_MS);
    expect(workers.some((worker) => worker.runner != null)).toBe(false);
    expect((await fetch(`${target.url}/api/workers/legacy`, { headers: { authorization: `Bearer ${token}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL), 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(401);
    const ended = await fetch(`${target.url}/worker/end`, {
      method: 'POST', headers: { ...memberHeadersFor(legacy.token, target.projectId), 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: target.projectId, runId: legacyRunId, attemptId: legacyRun.run.attemptId, status: 'failed', error: 'the legacy worker stopped' }),
    });
    expect(await ended.json()).toMatchObject({ ended: true });

    // A second request offering a candidate another request already holds is refused at its start, and no runner is written.
    const runners = (await fleet()).runners.length;
    const clashing = runnerBearer();
    await start(target, clashing);
    expect((await client(target, '/auth/runner/start', { name: 'twin', machineId: `runner_${crypto.randomUUID()}`, machineName: 'twin', os: 'linux', candidate: clashing })).status).toBe(400);
    expect((await fleet()).runners.length).toBe(runners);

    // The runner claims a queued run on its own credential and is handed no stored login.
    const sessionId = `sess_parity_runner_${now}`;
    await captureSession(target, sessionId, 'Title the runner run');
    const runId = await askTitle(target, sessionId);
    const claimed = (await asRunner(token, '/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES })).body as Record<string, any>;
    expect({ claimed: claimed.claimed, runId: claimed.run?.id, credentialEnv: claimed.run?.credentialEnv }).toEqual({ claimed: true, runId, credentialEnv: {} });
    expect((await runDetail(target, runId)).run.worker).toMatchObject({ runner: { id: runnerId }, member: null });
    const mcp = async () => (await browser(target, '/mcp', { authorization: `Bearer ${claimed.run.runToken}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL), [PROJECT_HEADER]: target.projectId, 'cf-connecting-ip': '1.2.3.4' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body as Record<string, any>;
    expect((await mcp()).result?.tools?.length).toBeGreaterThan(0);

    // Two owner pauses at once change the runner once, and a guarded contact answers the state the store holds.
    const paused = await Promise.all([1, 2].map(async () => (await browser(target, `/api/runners/${runnerId}/pause`, target.ownerHeaders(), {})).body as Record<string, any>));
    expect(paused.map((answer) => answer.changed).sort()).toEqual([false, true]);
    expect((await asRunner(token, '/runners/contact', { machineId: 'parity-mini-2' })).body).toMatchObject({ persisted: true, runner: { state: 'paused' } });

    // Removal ends the runner credential, its lease and its run token's reads at once.
    const removed = await browser(target, `/api/runners/${runnerId}/remove`, target.ownerHeaders(), {});
    expect(removed.body).toMatchObject({ changed: true, runner: { state: 'removed' } });
    expect((await asRunner(token, '/worker/lease', { projectId: target.projectId, runId, attemptId: claimed.run.attemptId })).status).toBe(401);
    expect((await mcp()).error?.data?.code).toBe('no_run');
    expect((await asRunner(token, '/runners/contact', { machineId: 'parity-removed' })).status).toBe(401);
    // The refused contact wrote nothing: the runner's last contact is still the paused one, which no client reads by machine.
    expect(await target.sql(`SELECT machine_id FROM runner_contacts WHERE runner_id = ${lit(runnerId)}`)).toEqual([{ machine_id: 'parity-mini-2' }]);
  },
};

/** The dashboard and compatibility inventory project the same persisted machines through both front doors. */
export const runnerFleet: ParityScenario = {
  name: 'runner fleet: display states, device replacement, terminal attribution, and queue',
  dedicated: { timeoutMs: 240000 },
  async run(target) {
    const admin = await runnerAdmin(target);
    const read = async (path = '/api/runners') => {
      const response = await browser(target, path, admin.session);
      expect(response.status).toBe(200);
      return response.body as Record<string, any>;
    };
    const asRunner = (token: string, path: string, body: unknown = {}) => client(target, path, body, token);
    const register = async (name: string) => {
      const token = runnerBearer();
      const started = await start(target, token, name, name);
      const approval = await browser(target, '/api/device/approve-runner', admin.session, { user_code: started.user_code });
      expect(approval.status).toBe(200);
      return { token, runnerId: String(approval.body.runnerId), started };
    };
    const offer = { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES };
    const never = await register('never');
    const idle = await register('idle');
    await asRunner(idle.token, '/worker/claim', offer);
    const empty = await register('no-agent');
    await asRunner(empty.token, '/worker/claim', { harnesses: [], capabilities: WORKER_CAPABILITIES });
    const unknown = await register('unknown');
    await asRunner(unknown.token, '/runners/contact', {});
    const settling = await register('waking');
    await asRunner(settling.token, '/worker/claim', offer);
    await asRunner(settling.token, '/runners/contact', { availability: 'settling', readinessReason: 'Waiting after waking.', arch: 'arm64' });
    const stale = await register('stale');
    await asRunner(stale.token, '/runners/contact', {});
    await ageRows(target, { table: 'runner_contacts', column: 'last_seen_at', byMs: PARK_MS, match: { runner_id: stale.runnerId } });
    const removed = await register('removed');
    expect((await browser(target, `/api/runners/${removed.runnerId}/remove`, admin.session, {})).status).toBe(200);
    const fleet = await read();
    const by = (id: string) => fleet.runners.find((row: any) => row.id === id);
    for (const [runner, display] of [[never, 'Never contacted'], [idle, 'Online'], [empty, 'Not ready'], [unknown, 'Not ready'], [settling, 'Not ready'], [stale, 'Offline']] as const)
      expect(by(runner.runnerId)?.display).toBe(display);
    expect(by(removed.runnerId)).toBeUndefined();
    expect(((await read('/api/runners/removed')).runners as any[]).map(row => row.id)).toEqual([removed.runnerId]);
    expect(by(settling.runnerId)).toMatchObject({ arch: 'arm64', readiness: { state: 'settling' } });
    expect(by(unknown.runnerId).offers).toBeNull();
    // A member reads registered machines and receives no control authority.
    expect((await assignRole(target, admin.id, 'member')).status).toBe(200);
    expect((await read()).runners).toHaveLength(6);
    for (const action of ['rename', 'pause', 'resume', 'remove', 'recredential', 'update'])
      expect((await browser(target, `/api/runners/${idle.runnerId}/${action}`, admin.session, { name: 'renamed', user_code: 'BCDF-GHJK' })).status).toBeGreaterThanOrEqual(400);
    expect((await assignRole(target, admin.id, 'admin')).status).toBe(200);
    expect((await browser(target, `/api/runners/${idle.runnerId}/rename`, admin.session, { name: 'work-laptop' })).status).toBe(200);
    expect((await browser(target, `/api/runners/${idle.runnerId}/pause`, admin.session, {})).status).toBe(200);
    expect((await read()).runners.find((row: any) => row.id === idle.runnerId)).toMatchObject({ display: 'Paused', name: 'work-laptop' });
    expect((await browser(target, `/api/runners/${idle.runnerId}/resume`, admin.session, {})).status).toBe(200);

    // A retired laptop's worker last asked for work on its member credential an hour ago.
    const retired = await deviceMachine(target, target.ownerHeaders(), 'retired-laptop');
    expect(await legacyClaim(target, retired.token)).toMatchObject({ claimed: false });
    await ageRows(target, { table: 'worker_contacts', column: 'last_seen_at', byMs: PARK_MS, match: { credential_id: retired.tokenId } });
    expect((await read()).legacyWorkers.find((row: any) => row.credentialId === retired.tokenId)).toMatchObject({ recent: false, busy: null });
    expect((await read('/api/status')).workers.fleet.find((row: any) => row.credentialId === retired.tokenId)).toMatchObject({ recent: false, busy: null });

    const replacementToken = runnerBearer();
    const replacement = await start(target, replacementToken, 'work-laptop', 'new-machine', true);
    expect((await browser(target, `/api/runners/${idle.runnerId}/recredential`, admin.session, { user_code: replacement.user_code })).status).toBe(200);
    expect((await read()).runners.find((row: any) => row.id === idle.runnerId)).toMatchObject({ display: 'Offline', awaitingReplacement: true, offers: null, busy: null });
    expect((await asRunner(idle.token, '/runners/contact')).status).toBe(401);
    expect((await client(target, '/auth/runner/poll', { device_code: replacement.device_code })).body).toMatchObject({ runnerId: idle.runnerId, name: 'work-laptop' });
    await stopMember(target, admin.id);
    expect((await fetch(`${target.url}/api/runners`, { headers: admin.session })).status).toBe(401);
  },
};
