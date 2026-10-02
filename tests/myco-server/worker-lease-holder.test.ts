import { offeredHarness } from './helpers/offered-harness.js';
/**
 * Who holds a run, and who ran it (#1424).
 *
 * A lease is one worker's until it lapses: a second worker is refused while it
 * is live and takes the run only after the sweep returns it to the queue. And
 * the durable run names the worker that ran it after it ends, so which machine
 * won a run is read off the run rather than recovered from worker logs.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID, claimNextRun, endLeasedRun, expireLeases, renewLease } from '@myco-server-worker/core/harness.js';
import { getRunDetail, listRuns } from '@myco-server-worker/read/runs.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import worker_ from '@myco-server-worker/entry/cloudflare.js';
import { memberHeaders } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const OFFERED = [offeredHarness('claude-code')];
const RUN = { projectId: 'proj_1', runId: 'run_1' };

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  e.sqlite.run(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
     VALUES ('proj_1', 'run_1', 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do the thing')`,
    [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })],
  );
  /** A worker: an administrator's credential issued on a named machine. */
  const issued = new Map<string, string>();
  const worker = async (memberId: string, machineId: string) => {
    e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'a worker', ?, 'admin')`, [memberId, NOW]);
    const minted = await issueMemberToken(e.db, { memberId, machineId }, NOW);
    issued.set(minted.tokenId, minted.token);
    return minted.tokenId;
  };
  /** A worker route asked over the Deployment's own pipeline, as the worker whose credential this is. */
  const route = async (tokenId: string, path: string, body: unknown) => {
    const res = await worker_.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(issued.get(tokenId)!), body: JSON.stringify(body) }), e.env);
    return await res.json() as Record<string, unknown>;
  };
  const claim = (tokenId: string, now: number) => claimNextRun(e.serverEnv, { tokenId, machineId: 'unused', harnesses: OFFERED, now });
  const row = () => e.sqlite.query(`SELECT status, leased_by AS leasedBy, lease_expires_at AS leaseExpiresAt FROM agent_runs WHERE id = 'run_1'`).get() as Record<string, unknown>;
  return { e, worker, claim, row, route };
}

describe('the lease on a run', () => {
  it('refuses a second worker while the first holds a live lease', async () => {
    const r = await rig();
    const [mac, vm] = [await r.worker('mem_mac', 'sirkirby_mac'), await r.worker('mem_vm', 'local_vm')];
    expect((await r.claim(mac, NOW)).claimed).toBe(true);
    // Every instant inside the lease: the other worker is told there is nothing to take, and cannot renew it.
    for (const at of [NOW + 1, NOW + WORKER_LEASE_MS / 2, NOW + WORKER_LEASE_MS - 1]) {
      expect(await r.claim(vm, at)).toEqual({ claimed: false, reason: 'no_work' });
      expect((await renewLease(r.e.serverEnv, { tokenId: vm, now: at }, RUN)).held).toBe(false);
      expect(await expireLeases(r.e.serverEnv, at)).toBe(0);
    }
    expect(r.row()).toMatchObject({ status: 'running', leasedBy: mac });
  });

  it('hands a run on once its holder genuinely stopped renewing, and not to the holder that lapsed', async () => {
    const r = await rig();
    const [mac, vm] = [await r.worker('mem_mac', 'sirkirby_mac'), await r.worker('mem_vm', 'local_vm')];
    expect((await r.claim(mac, NOW)).claimed).toBe(true);
    expect(await expireLeases(r.e.serverEnv, NOW + WORKER_LEASE_MS)).toBe(1);
    const taken = await r.claim(vm, NOW + WORKER_LEASE_MS + 1);
    expect(taken.claimed).toBe(true);
    expect(r.row()).toMatchObject({ status: 'running', leasedBy: vm });
    // The lapsed holder learns it lost the run, and cannot end it.
    expect((await renewLease(r.e.serverEnv, { tokenId: mac, now: NOW + WORKER_LEASE_MS + 2 }, RUN)).held).toBe(false);
    expect(await endLeasedRun(r.e.serverEnv, { tokenId: mac, now: NOW + WORKER_LEASE_MS + 3 }, { ...RUN, status: 'completed' }))
      .toEqual({ ended: false, reason: 'the lease is no longer held' });
    expect(r.row()).toMatchObject({ status: 'running', leasedBy: vm });
  });
});

describe('a renewal names the attempt it renews', () => {
  it('renews the attempt a worker names and no earlier one, and renews as before for a worker that names none', async () => {
    const r = await rig();
    // The Deployment's pipeline reads the real clock, so the claims are placed around it.
    const now = Date.now();
    const mac = await r.worker('mem_mac', 'sirkirby_mac');
    const first = await r.claim(mac, now);
    if (!first.claimed) throw new Error('not claimed');
    // The same worker's lease lapses and it takes the run again: a second attempt, on the same credential.
    await expireLeases(r.e.serverEnv, now + WORKER_LEASE_MS);
    const second = await r.claim(mac, now + WORKER_LEASE_MS + 1);
    if (!second.claimed) throw new Error('not reclaimed');
    expect(second.run.attemptId).not.toBe(first.run.attemptId);
    expect(await r.route(mac, '/worker/lease', { ...RUN, attemptId: first.run.attemptId })).toMatchObject({ persisted: true, held: false });
    expect(await r.route(mac, '/worker/lease', { ...RUN, attemptId: second.run.attemptId })).toMatchObject({ persisted: true, held: true, leaseMs: WORKER_LEASE_MS });
    expect(await r.route(mac, '/worker/lease', RUN)).toMatchObject({ persisted: true, held: true, leaseMs: WORKER_LEASE_MS });
  });

  it('refuses a renewal naming an attempt it cannot read, as it refuses such an end', async () => {
    const r = await rig();
    const mac = await r.worker('mem_mac', 'sirkirby_mac');
    expect((await r.claim(mac, Date.now())).claimed).toBe(true);
    for (const attemptId of ['not an id!', 42, '']) {
      expect({ attemptId, lease: await r.route(mac, '/worker/lease', { ...RUN, attemptId }) })
        .toEqual({ attemptId, lease: { persisted: false, code: 'parse', reason: expect.any(String) } });
      expect({ attemptId, end: await r.route(mac, '/worker/end', { ...RUN, status: 'failed', attemptId }) })
        .toEqual({ attemptId, end: { persisted: false, code: 'parse', reason: expect.any(String) } });
    }
    expect(r.row()).toMatchObject({ status: 'running', leasedBy: mac });
  });
});

describe('the worker that ran a run', () => {
  it('is named on the run after it ends, with the machine its credential was issued to', async () => {
    const r = await rig();
    const [mac, vm] = [await r.worker('mem_mac', 'sirkirby_mac'), await r.worker('mem_vm', 'local_vm')];
    const claimed = await r.claim(vm, NOW);
    if (!claimed.claimed) throw new Error('not claimed');
    expect(await r.claim(mac, NOW + 1)).toEqual({ claimed: false, reason: 'no_work' });
    expect(await endLeasedRun(r.e.serverEnv, { tokenId: vm, now: NOW + 5_000 }, { ...RUN, status: 'failed', error: 'x', attemptId: claimed.run.attemptId }))
      .toMatchObject({ ended: true });

    // The lease is over, and the run still says whose it was.
    expect(r.row()).toMatchObject({ status: 'failed', leasedBy: vm, leaseExpiresAt: null });
    const detail = await getRunDetail(r.e.db, SCOPE, 'run_1', Date.now(), 'mem_viewer');
    expect(detail?.run).toMatchObject({ status: 'failed', leasedBy: null, leaseExpiresAt: null, worker: { credentialId: vm, machineId: 'local_vm' } });
    const page = await listRuns(r.e.db, SCOPE, Date.now(), 'mem_viewer');
    expect(page.rows[0]).toMatchObject({ id: 'run_1', worker: { credentialId: vm, machineId: 'local_vm' } });
  });

  it('is named while the run is held, and names nobody for a run no worker took', async () => {
    const r = await rig();
    const mac = await r.worker('mem_mac', 'sirkirby_mac');
    expect((await getRunDetail(r.e.db, SCOPE, 'run_1', Date.now(), 'mem_viewer'))?.run).toMatchObject({ status: 'queued', worker: null });
    await r.claim(mac, NOW);
    expect((await getRunDetail(r.e.db, SCOPE, 'run_1', Date.now(), 'mem_viewer'))?.run).toMatchObject({ status: 'running', leasedBy: mac, worker: { credentialId: mac, machineId: 'sirkirby_mac' } });
    // A run returned to the queue names nobody: nobody is running it.
    await expireLeases(r.e.serverEnv, NOW + WORKER_LEASE_MS);
    expect((await getRunDetail(r.e.db, SCOPE, 'run_1', Date.now(), 'mem_viewer'))?.run).toMatchObject({ status: 'queued', worker: null });
  });
});
