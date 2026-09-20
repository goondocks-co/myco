/**
 * What a run says about the worker that holds it.
 *
 * The claim writes the harness it chose, the worker credential and the lease in
 * one statement; a terminal close and a requeue both stop the row naming a
 * holder. A reader must be able to tell a run held right now from one whose
 * holder the row no longer names, and must never read the second as "no worker
 * ran it". These gates hold that distinction across the read layer and the
 * product surface, and hold the credential a run was dispatched under apart
 * from the worker that drove it.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { applyRunUpdate, claimQueuedRun, lapsedLeases, NO_LIMITS, requeueLapsedLease } from '@myco-server-worker/core/runs.js';
import { getRunDetail, listRuns } from '@myco-server-worker/read/runs.js';
import { listCredentials } from '@myco-server-worker/read/credentials.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const LEASE_UNTIL = NOW + 90_000;
const SCOPE = { projectId: 'proj_1' };
const CANDIDATE = { projectId: 'proj_1', id: 'run_1', task: 'title-summary', instruction: 'do the thing', dispatchSpec: null };

async function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  fixture.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  fixture.sqlite.run(
    `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, instruction)
     VALUES ('run_1', 'proj_1', 'myco-agent', 'title-summary', 'queued', ?, 'do the thing')`,
    [NOW],
  );
  await ensureMember(fixture.db, 'mem_worker', NOW, 'admin', 'the worker machine');
  await ensureMember(fixture.db, 'mem_harness', NOW, 'member', 'harness runtime');
  const workerCredential = await issueMemberToken(fixture.db, { memberId: 'mem_worker', machineId: 'sirkirby-mbp' }, NOW);
  const runCredential = await issueMemberToken(fixture.db, { memberId: 'mem_harness', machineId: 'harness' }, NOW);
  const claim = () => claimQueuedRun(fixture.db, CANDIDATE, {
    dispatchedBy: runCredential.tokenId, leasedBy: workerCredential.tokenId, leaseExpiresAt: LEASE_UNTIL, harness: 'codex', now: NOW,
  }, { limits: NO_LIMITS, now: NOW });
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await worker.fetch(await asOwner(path), env);
    return await res.json() as Record<string, unknown>;
  };
  return { ...fixture, env, claim, get, workerCredential, runCredential };
}

describe('a run names the worker holding it', () => {
  it('carries the chosen harness, the worker credential and the lease while the run is held', async () => {
    const r = await rig();
    expect(await r.claim()).not.toBeNull();

    const page = await listRuns(r.db, SCOPE);
    expect(page.rows[0]).toMatchObject({ id: 'run_1', status: 'running', harness: 'codex', leasedBy: r.workerCredential.tokenId, leaseExpiresAt: LEASE_UNTIL });

    const detail = await getRunDetail(r.db, SCOPE, 'run_1');
    expect(detail?.run).toMatchObject({ harness: 'codex', leasedBy: r.workerCredential.tokenId, leaseExpiresAt: LEASE_UNTIL });
    // The credential the run was dispatched under is the harness child's, not the worker's.
    expect(detail?.run.dispatchedBy).toBe(r.runCredential.tokenId);
    expect(detail?.run.dispatchedBy).not.toBe(r.workerCredential.tokenId);
  });

  it('stops naming a holder when the run ends, and keeps the harness it ran on', async () => {
    const r = await rig();
    await r.claim();
    const changed = await applyRunUpdate(r.db, SCOPE, 'run_1', { status: 'completed', completed_at: NOW + 1_000 },
      { tokenId: r.workerCredential.tokenId, dispatchedBy: r.runCredential.tokenId, now: NOW });
    expect(changed).toBe(1);

    const detail = await getRunDetail(r.db, SCOPE, 'run_1');
    expect(detail?.run).toMatchObject({ status: 'completed', harness: 'codex', leasedBy: null, leaseExpiresAt: null });
  });

  it('stops naming a holder when the server ends the run without the worker\'s lease', async () => {
    const r = await rig();
    await r.claim();
    // A launch failure and the owner's own close both end a run with no lease argument.
    expect(await applyRunUpdate(r.db, SCOPE, 'run_1', { status: 'failed', completed_at: NOW + 500, error: 'the runtime refused to start' })).toBe(1);

    const row = r.sqlite.query(`SELECT leased_by, lease_expires_at FROM agent_runs WHERE id = 'run_1'`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ leased_by: null, lease_expires_at: null });
    // The sweep takes running rows only, so a terminal row keeping a lease would never be swept.
    expect(await lapsedLeases(r.db, LEASE_UNTIL + 1, 10)).toEqual([]);
  });

  it('reads a row written before that release as the ending it is, not as a holder awaiting a sweep', async () => {
    const r = await rig();
    // A terminal row still carrying both columns, as one written by an earlier release would.
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, completed_at, harness, leased_by, lease_expires_at)
       VALUES ('run_old', 'proj_1', 'myco-agent', 'title-summary', 'failed', ?, ?, ?, 'codex', ?, ?)`,
      [NOW, NOW, NOW + 100, r.workerCredential.tokenId, NOW - 60_000],
    );
    const detail = await getRunDetail(r.db, SCOPE, 'run_old');
    expect(detail?.run).toMatchObject({ status: 'failed', harness: 'codex', leasedBy: null, leaseExpiresAt: null });
    const listed = (await listRuns(r.db, SCOPE)).rows.find((row) => row.id === 'run_old');
    expect(listed).toMatchObject({ leasedBy: null, leaseExpiresAt: null });
  });

  it('stops naming a holder when a lapsed lease returns the run to the queue', async () => {
    const r = await rig();
    await r.claim();
    expect(await requeueLapsedLease(r.db, SCOPE, 'run_1', r.workerCredential.tokenId, LEASE_UNTIL + 1)).toBe(true);

    const detail = await getRunDetail(r.db, SCOPE, 'run_1');
    expect(detail?.run).toMatchObject({ status: 'queued', leasedBy: null, leaseExpiresAt: null, dispatchedBy: null });
  });

  it('serves the same three facts through the product surface', async () => {
    const r = await rig();
    await r.claim();
    const rows = (await r.get('/api/projects/proj_1/runs')).rows as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ harness: 'codex', leasedBy: r.workerCredential.tokenId, leaseExpiresAt: LEASE_UNTIL });

    const detail = (await r.get('/api/projects/proj_1/runs/run_1')).run as Record<string, unknown>;
    expect(detail).toMatchObject({ harness: 'codex', leasedBy: r.workerCredential.tokenId, leaseExpiresAt: LEASE_UNTIL });
  });

  it('names a run whose row never held a lease as recording none, rather than as having had no worker', async () => {
    const r = await rig();
    const detail = await getRunDetail(r.db, SCOPE, 'run_1');
    expect(detail?.run).toMatchObject({ status: 'queued', harness: null, leasedBy: null, leaseExpiresAt: null });
  });
});

describe('a credential says what it was minted for', () => {
  it('tells a run credential from a member runtime by the identity it was minted under', async () => {
    const r = await rig();
    await r.claim();
    const page = await listCredentials(r.db, NOW);
    const byId = new Map(page.rows.map((row) => [row.id, row.purpose]));
    expect(byId.get(r.runCredential.tokenId)).toBe('run');
    expect(byId.get(r.workerCredential.tokenId)).toBe('member');
  });

  it('leaves a member credential that registered a run of its own a member runtime', async () => {
    const r = await rig();
    // The member run route records the caller's own credential as the dispatcher.
    r.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, started_at, dispatched_by)
       VALUES ('run_member', 'proj_1', 'myco-agent', 'digest', 'running', ?, ?)`,
      [NOW, r.workerCredential.tokenId],
    );
    const page = await listCredentials(r.db, NOW);
    expect(page.rows.find((row) => row.id === r.workerCredential.tokenId)?.purpose).toBe('member');
  });

  it('keeps a run credential a run credential once the run stops naming it', async () => {
    const r = await rig();
    await r.claim();
    expect(await requeueLapsedLease(r.db, SCOPE, 'run_1', r.workerCredential.tokenId, LEASE_UNTIL + 1)).toBe(true);
    const page = await listCredentials(r.db, NOW);
    expect(page.rows.find((row) => row.id === r.runCredential.tokenId)?.purpose).toBe('run');
  });

  it('narrows to one purpose before the page is taken, so an archive of run credentials cannot bury a runtime', async () => {
    const r = await rig();
    // More run credentials than one page holds, every one minted after the runtime.
    for (let i = 0; i < 60; i++) await issueMemberToken(r.db, { memberId: 'mem_harness', machineId: 'harness' }, NOW + 1_000 + i);

    const runtimes = await listCredentials(r.db, NOW, { purpose: 'member', limit: 50 });
    expect(runtimes.rows.map((row) => row.id)).toContain(r.workerCredential.tokenId);
    expect(runtimes.rows.every((row) => row.purpose === 'member')).toBe(true);

    // The archive stays readable on a page of its own.
    const runs = await listCredentials(r.db, NOW, { purpose: 'run', limit: 50 });
    expect(runs.rows).toHaveLength(50);
    expect(runs.cursor).not.toBeNull();
    expect(runs.rows.every((row) => row.purpose === 'run')).toBe(true);
  });

  it('serves the purpose through the product surface and refuses one it does not know', async () => {
    const r = await rig();
    await r.claim();
    const rows = (await r.get('/api/credentials?purpose=member')).rows as Record<string, unknown>[];
    expect(rows.every((row) => row.purpose === 'member')).toBe(true);
    expect(rows.some((row) => row.id === r.runCredential.tokenId)).toBe(false);
    expect(rows.some((row) => row.id === r.workerCredential.tokenId)).toBe(true);

    const res = await worker.fetch(await asOwner('/api/credentials?purpose=elsewhere'), r.env);
    expect(res.status).toBe(400);
  });
});
