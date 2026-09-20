/**
 * What Status can say about workers, and what it must refuse to say.
 *
 * A lease is a fact about a busy worker; everything else here is a worker's own
 * report, recorded by the claim it already makes. These gates hold the line
 * between the two: busy comes from a live lease and never from a stored claim
 * reason, an idle worker is distinguishable from no worker, a credential that
 * can no longer take work does not read as ready, and a Deployment that cannot
 * read its own store answers "not known" rather than "none attached".
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { CONTACT_RECENT_MS, CONTACT_THROTTLE_MS, readWorkerFleet, recordWorkerContact, pruneWorkerContacts, WORKER_CONTACT_RETENTION_MS } from '@myco-server-worker/core/worker-contacts.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwner, asOwnerPut } from './helpers/owner.js';

const NOW = 1_800_000_000_000;

function post(token: string, path: string, body: unknown): Request {
  return new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token, { 'x-myco-now': String(NOW) }), body: JSON.stringify(body) });
}

async function rig() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
  const admin = async (id: string, machineId: string) => {
    await ensureMember(e.db, id, NOW, 'admin', id);
    const minted = await issueMemberToken(e.db, { memberId: id, machineId }, NOW);
    return minted;
  };
  const json = async (req: Request) => {
    const res = await worker.fetch(req, e.env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { e, admin, json };
}

/** The offer an ordinary laptop worker makes: one harness logged in, one present but not. */
const OFFER = [{ id: 'codex', authenticated: true }, { id: 'claude-code', authenticated: false }];

describe('what a worker last said about itself', () => {
  it('records an idle worker that took no run, so an attached worker no longer reads like no worker', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'sirkirby-mbp');

    // The route stamps the server's own clock, so the window is read rather than pinned.
    const before = Date.now();
    const answered = await r.json(post(worker1.token, '/worker/claim', { harnesses: OFFER, capabilities: ['repository-checkout'] }));
    expect(answered.body).toMatchObject({ claimed: false, reason: 'no_work' });

    const fleet = await readWorkerFleet(r.e.db, Date.now());
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({
      credentialId: worker1.tokenId,
      machineId: 'sirkirby-mbp',
      offers: OFFER,
      capabilities: ['repository-checkout'],
      lastReason: 'no_work',
      busy: null,
      eligible: true,
      recent: true,
    });
    expect(fleet[0]!.lastSeenAt).toBeGreaterThanOrEqual(before);
  });

  it('holds an unchanged observation to the throttle and writes a changed one at once', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'mba');

    expect(await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW })).toBe(true);
    // The same report again, one poll later: nothing to say, nothing written.
    expect(await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW + 2_000 })).toBe(false);
    // Past the throttle the liveness is refreshed even unchanged.
    expect(await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW + CONTACT_THROTTLE_MS })).toBe(true);
    // A harness logging out is material and is not made to wait.
    const loggedOut = [{ id: 'codex', authenticated: false }, { id: 'claude-code', authenticated: false }];
    expect(await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: loggedOut, capabilities: [], reason: 'no_work', now: NOW + CONTACT_THROTTLE_MS + 1 })).toBe(true);
    expect((await readWorkerFleet(r.e.db, NOW + CONTACT_THROTTLE_MS + 1))[0]?.offers).toEqual(loggedOut);
  });

  it('keeps a lease-renewing worker busy and recent past the contact threshold, without a claim of its own', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'vm-1');
    // A run this worker holds. Busy is read from the lease, so the row is the authority.
    r.e.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at, dispatched_by)
       VALUES ('run_1', 'proj_1', 'myco-agent', 'title-summary', 'running', ?, ?, ?, ?, NULL)`,
      [NOW, NOW, worker1.tokenId, NOW + CONTACT_RECENT_MS + 120_000],
    );
    await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'vm-1', offers: OFFER, capabilities: [], reason: 'claimed', now: NOW });

    // Long enough that the last claim alone would read as stale, while the lease still holds.
    const later = NOW + CONTACT_RECENT_MS + 30_000;
    const stale = await readWorkerFleet(r.e.db, later);
    expect({ recent: stale[0]?.recent, busy: stale[0]?.busy?.runId }).toEqual({ recent: false, busy: 'run_1' });

    // The renewal is the only contact a driving worker makes; it refreshes liveness
    // and keeps the report it already gave.
    r.e.sqlite.run(`UPDATE agent_runs SET lease_expires_at = ? WHERE id = 'run_1'`, [later + 90_000]);
    await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'vm-1', now: later });
    const renewed = await readWorkerFleet(r.e.db, later);
    expect(renewed[0]).toMatchObject({ recent: true, lastReason: 'claimed', offers: OFFER, busy: { runId: 'run_1', task: 'title-summary', projectId: 'proj_1' } });
  });

  it('shows a worker that holds a lease but has never been recorded, as busy with no contact time', async () => {
    const r = await rig();
    const older = await r.admin('mem_old', 'legacy-box');
    r.e.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at, dispatched_by)
       VALUES ('run_2', 'proj_1', 'myco-agent', 'extract-curate', 'running', ?, ?, ?, ?, NULL)`,
      [NOW, NOW, older.tokenId, NOW + 90_000],
    );
    const fleet = await readWorkerFleet(r.e.db, NOW);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ credentialId: older.tokenId, machineId: 'legacy-box', lastSeenAt: 0, lastReason: null, recent: false, busy: { runId: 'run_2' } });
  });

  it('records why the latest claim took nothing, without claiming the queue cannot move', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'mba');
    // A queued run and a Deployment preferring a harness this worker has not logged in.
    r.e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('worker.harness', ?, ?, 'test')`, [JSON.stringify('claude-code'), NOW]);
    r.e.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, dispatch_spec, instruction)
       VALUES ('run_3', 'proj_1', 'myco-agent', 'title-summary', 'queued', ?, NULL, 'do the thing')`,
      [NOW],
    );

    const answered = await r.json(post(worker1.token, '/worker/claim', { harnesses: OFFER, capabilities: ['repository-checkout'] }));
    expect(answered.body).toMatchObject({ claimed: false, reason: 'no_harness' });

    const fleet = await readWorkerFleet(r.e.db, NOW);
    // The stored reason is this worker's latest claim, beside the queue depth the
    // status surface reads separately. Nothing here says another worker could not run it.
    expect(fleet[0]).toMatchObject({ lastReason: 'no_harness', busy: null, offers: OFFER });
  });

  it('bounds one sweep to its batch, taking the oldest observations first', async () => {
    const r = await rig();
    const long = NOW - WORKER_CONTACT_RETENTION_MS - 10_000;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await r.admin(`mem_b${i}`, `box-${i}`);
      ids.push(w.tokenId);
      await recordWorkerContact(r.e.db, { credentialId: w.tokenId, machineId: `box-${i}`, offers: OFFER, capabilities: [], reason: 'no_work', now: long + i });
    }
    expect(await pruneWorkerContacts(r.e.db, NOW, WORKER_CONTACT_RETENTION_MS, 2)).toBe(2);
    expect((await readWorkerFleet(r.e.db, NOW)).map((w) => w.credentialId)).toEqual([ids[2]!]);
  });

  it('answers unknown for a stored report it cannot read, rather than an empty one', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'mba');
    await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: ['repository-checkout'], reason: 'no_work', now: NOW });
    r.e.sqlite.run(`UPDATE worker_contacts SET offers = '[{"id":', capabilities = 'not json' WHERE credential_id = ?`, [worker1.tokenId]);

    const fleet = await readWorkerFleet(r.e.db, NOW);
    expect(fleet[0]).toMatchObject({ offers: null, capabilities: null, lastReason: 'no_work' });

    // An unreadable report is replaced by the next one the worker makes.
    expect(await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: ['repository-checkout'], reason: 'no_work', now: NOW + 1_000 })).toBe(true);
    expect((await readWorkerFleet(r.e.db, NOW + 1_000))[0]).toMatchObject({ offers: OFFER });
  });

  it('stops calling a worker eligible once its member no longer administers the Deployment, as the claim route does', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'mba');
    await r.json(post(worker1.token, '/worker/claim', { harnesses: OFFER, capabilities: [] }));
    expect((await readWorkerFleet(r.e.db, Date.now()))[0]).toMatchObject({ eligible: true });

    r.e.sqlite.run(`UPDATE members SET role = 'member' WHERE id = 'mem_w1'`);
    const refused = await r.json(post(worker1.token, '/worker/claim', { harnesses: OFFER, capabilities: [] }));
    expect(refused.body).toMatchObject({ persisted: false, code: 'not_admin' });
    expect((await readWorkerFleet(r.e.db, Date.now()))[0]).toMatchObject({ eligible: false });

    // A member the Deployment no longer holds is refused on the same line.
    r.e.sqlite.run(`UPDATE members SET role = 'admin', revoked_at = ? WHERE id = 'mem_w1'`, [NOW]);
    expect((await readWorkerFleet(r.e.db, Date.now()))[0]).toMatchObject({ eligible: false });
  });

  it('never lets a revoked credential read as eligible for new work', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'mba');
    await recordWorkerContact(r.e.db, { credentialId: worker1.tokenId, machineId: 'mba', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW });
    r.e.sqlite.run(`UPDATE member_credentials SET revoked_at = ? WHERE id = ?`, [NOW + 1, worker1.tokenId]);
    expect((await readWorkerFleet(r.e.db, NOW + 2))[0]).toMatchObject({ eligible: false, recent: true });

    // An expired one is no more eligible than a revoked one.
    r.e.sqlite.run(`UPDATE member_credentials SET revoked_at = NULL, expires_at = ? WHERE id = ?`, [NOW + 1, worker1.tokenId]);
    expect((await readWorkerFleet(r.e.db, NOW + 2))[0]).toMatchObject({ eligible: false });
  });

  it('forgets a worker unheard from past the horizon and keeps one still holding a lease', async () => {
    const r = await rig();
    const gone = await r.admin('mem_gone', 'old-laptop');
    const holding = await r.admin('mem_hold', 'vm-1');
    const long = NOW - WORKER_CONTACT_RETENTION_MS - 1;
    await recordWorkerContact(r.e.db, { credentialId: gone.tokenId, machineId: 'old-laptop', offers: OFFER, capabilities: [], reason: 'no_work', now: long });
    await recordWorkerContact(r.e.db, { credentialId: holding.tokenId, machineId: 'vm-1', offers: OFFER, capabilities: [], reason: 'claimed', now: long });
    r.e.sqlite.run(
      `INSERT INTO agent_runs (id, project_id, agent_id, task, status, queued_at, started_at, leased_by, lease_expires_at, dispatched_by)
       VALUES ('run_4', 'proj_1', 'myco-agent', 'title-summary', 'running', ?, ?, ?, ?, NULL)`,
      [long, long, holding.tokenId, NOW + 90_000],
    );

    expect(await pruneWorkerContacts(r.e.db, NOW, WORKER_CONTACT_RETENTION_MS, 200)).toBe(1);
    const left = await readWorkerFleet(r.e.db, NOW);
    expect(left.map((w) => w.credentialId)).toEqual([holding.tokenId]);
  });
});

describe('what Status answers about workers', () => {
  it('carries the fleet, the queue and an availability flag the panel reads first', async () => {
    const r = await rig();
    const worker1 = await r.admin('mem_w1', 'sirkirby-mbp');
    await r.json(post(worker1.token, '/worker/claim', { harnesses: OFFER, capabilities: ['repository-checkout'] }));

    const res = await worker.fetch(await asOwner('/api/status'), { ...r.e.env, ...OWNER_ENV });
    const body = await res.json() as { workers: { available: boolean; workersBusy: number; runsQueued: number; recentWithinMs: number; fleet: Record<string, unknown>[] } };
    expect(body.workers.available).toBe(true);
    expect(body.workers.recentWithinMs).toBe(CONTACT_RECENT_MS);
    expect(body.workers.fleet).toHaveLength(1);
    expect(body.workers.fleet[0]).toMatchObject({ machineId: 'sirkirby-mbp', lastReason: 'no_work', busy: null, eligible: true });
    // No token value and no credential environment ever travels on this surface.
    expect(JSON.stringify(body.workers)).not.toContain(worker1.token);
  });

  it('keeps a value an older deployment stored for a control the dashboard no longer offers', async () => {
    const r = await rig();
    // `agent.harness` named the retired in-binary runtime. Its editor is gone, and
    // the leaf is still accepted and still readable, so nothing an owner stored is lost.
    const written = await worker.fetch(await asOwnerPut('/api/settings/agent.harness', { value: 'claude-sdk' }), { ...r.e.env, ...OWNER_ENV });
    expect(written.status).toBe(200);

    const res = await worker.fetch(await asOwner('/api/settings'), { ...r.e.env, ...OWNER_ENV });
    const body = await res.json() as { leaves: { leaf: string; value: unknown; configured: boolean }[] };
    expect(body.leaves.find((l) => l.leaf === 'agent.harness')).toMatchObject({ value: 'claude-sdk', configured: true });
  });

  it('answers unavailable rather than zero workers when the store cannot be read', async () => {
    const r = await rig();
    r.e.sqlite.run(`DROP TABLE worker_contacts`);
    const res = await worker.fetch(await asOwner('/api/status'), { ...r.e.env, ...OWNER_ENV });
    const body = await res.json() as { workers: { available: boolean; fleet: unknown[] } };
    expect(body.workers.available).toBe(false);
    expect(body.workers.fleet).toEqual([]);
  });
});
