/**
 * The claim queue and the lease a worker holds on what it took.
 *
 * The behaviour the issue's gate names: a killed worker's run returns to the
 * queue at lease expiry, is re-claimable after it, and is never double-claimed
 * before it.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { claimNextRun, endLeasedRun, expireLeases, renewLease, chooseHarness, RUNTIME_SERVED_TASKS } from '@myco-server-worker/core/harness.js';
import { getRun, workerLiveness } from '@myco-server-worker/core/runs.js';
import { WORKER_HEARTBEAT_MS, WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { TASK_RUN_TIMEOUT_SECONDS } from '@myco-server-worker/core/task-catalogue.js';
import { RUN_OVERRUN_MARGIN_MS } from '@myco-server-worker/core/harness.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const OFFERED = [{ id: 'claude-code', authenticated: true }];

/** A Deployment holding one queued run of a worker-served task. */
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

function fixture(task = 'extract-curate') {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  const queue = (id: string, at: number, over: Record<string, unknown> = {}) => {
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction, dispatched_by)
       VALUES ('proj_1', ?, 'myco-agent', ?, 'queued', ?, 'worker', ?, ?, 'do the thing', ?)`,
      [id, task, at, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 }), (over.dispatchedBy as string | null) ?? null],
    );
  };
  // A worker's lease names its own credential, which the schema holds to a real
  // one: the pipeline has authenticated it before any claim reaches the core.
  const worker = async (memberId: string) => {
    e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'a worker', ?, 'admin')`, [memberId, NOW]);
    return (await issueMemberToken(e.db, { memberId, machineId: memberId }, NOW)).tokenId;
  };
  const row = (id: string) => e.sqlite.query(`SELECT status, leased_by AS leasedBy, lease_expires_at AS leaseExpiresAt, dispatched_by AS dispatchedBy, harness, started_at AS startedAt FROM agent_runs WHERE id = ?`).get(id) as Record<string, unknown>;
  const live = (tokenId: string) => e.sqlite.query(`SELECT revoked_at FROM member_credentials WHERE id = ?`).get(tokenId) as { revoked_at: number | null } | null;
  return { e, queue, row, live, worker };
}

describe('the claim queue', () => {
  it('takes the oldest run a worker can serve, naming its credential in the same write', async () => {
    const f = fixture();
    f.queue('run_new', NOW + 10);
    f.queue('run_old', NOW);
    const claimed = await claimNextRun(f.e.serverEnv, { tokenId: await f.worker('mem_w'), machineId: 'm1', harnesses: OFFERED, now: NOW + 100 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    // The oldest waits longest, so it goes first.
    expect(claimed.run.id).toBe('run_old');
    const taken = f.row('run_old');
    expect({ status: taken.status, harness: taken.harness, startedAt: taken.startedAt }).toEqual({ status: 'running', harness: 'claude-code', startedAt: NOW + 100 });
    // The row names the credential the claim answered, so the MCP surface
    // resolves the run the moment the worker has its token.
    expect(taken.dispatchedBy).not.toBeNull();
    expect(taken.leasedBy).not.toBeNull();
    expect(taken.leaseExpiresAt).toBe(NOW + 100 + WORKER_LEASE_MS);
    // The run's own budget travels with it, so a worker bounds the harness.
    expect(claimed.run.timeoutSeconds).toBeGreaterThan(0);
  });

  it('answers exactly one of two workers claiming at once', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const [ta, tb] = [await f.worker('mem_a'), await f.worker('mem_b')];
    const [a, b] = await Promise.all([
      claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 }),
      claimNextRun(f.e.serverEnv, { tokenId: tb, machineId: 'm2', harnesses: OFFERED, now: NOW + 1 }),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.claimed ? b : a;
    expect(loser).toEqual({ claimed: false, reason: 'lost_race' });
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'`).get()).toEqual({ n: 1 });
  });

  it('holds a claim at the limits the Deployment set, and records the limit on the run', async () => {
    const f = fixture();
    f.e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.limits.concurrent_runs', '1', ?, 'test')`, [NOW]);
    f.queue('run_1', NOW);
    f.queue('run_2', NOW + 1);
    const [ta, tb] = [await f.worker('mem_a'), await f.worker('mem_b')];

    // One run at a time: the first worker takes one, the second is held by the
    // limit rather than taking the other, and the limit is on the row an
    // operator reads.
    const first = await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW + 2 });
    expect(first.claimed).toBe(true);
    expect(await claimNextRun(f.e.serverEnv, { tokenId: tb, machineId: 'm2', harnesses: OFFERED, now: NOW + 3 }))
      .toEqual({ claimed: false, reason: 'at_limit' });
    expect(f.row('run_2')).toMatchObject({ status: 'queued' });
    expect(f.e.sqlite.query(`SELECT held_by AS heldBy FROM agent_runs WHERE id = 'run_2'`).get()).toEqual({ heldBy: 'concurrent_runs' });
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'`).get()).toEqual({ n: 1 });
    // A refused claim mints and retires: the queue is peeked before anything is
    // minted, and a mint the write then refuses is revoked at once, so exactly
    // one credential is live and the other is a revoked row.
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials WHERE member_id = ?`).get(HARNESS_MEMBER_ID)).toEqual({ n: 2 });
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials WHERE revoked_at IS NULL AND member_id = ?`).get(HARNESS_MEMBER_ID)).toEqual({ n: 1 });

    // The first ending frees the place, and the second run is taken.
    f.e.sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'run_1'`, [NOW + 4]);
    expect((await claimNextRun(f.e.serverEnv, { tokenId: tb, machineId: 'm2', harnesses: OFFERED, now: NOW + 5 })).claimed).toBe(true);
  });

  it('leaves a queued run that still names a launch credential to the launch that holds it', async () => {
    const f = fixture();
    f.queue('run_held', NOW);
    const launch = await issueMemberToken(f.e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);
    f.e.sqlite.run(`UPDATE agent_runs SET dispatched_by = ? WHERE id = 'run_held'`, [launch.tokenId]);
    // A row the queue took back from a launch is that launch's to reclaim; a
    // worker taking it would run the same work twice.
    expect(await claimNextRun(f.e.serverEnv, { tokenId: await f.worker('mem_w'), machineId: 'm1', harnesses: OFFERED, now: NOW + 1 })).toEqual({ claimed: false, reason: 'no_work' });
  });

  it('leaves the three tasks the launch seam serves out of the queue a worker reads', async () => {
    // Named here rather than read from the constant: a list that loops over
    // itself passes on an empty one.
    expect([...RUNTIME_SERVED_TASKS].sort()).toEqual(['canopy-map', 'container-smoke', 'embedding-reconcile']);
    for (const task of ['canopy-map', 'container-smoke', 'embedding-reconcile']) {
      const f = fixture(task);
      f.queue(`run_${task}`, NOW);
      expect({ task, outcome: await claimNextRun(f.e.serverEnv, { tokenId: await f.worker('mem_w'), machineId: 'm1', harnesses: OFFERED, now: NOW + 1 }) })
        .toEqual({ task, outcome: { claimed: false, reason: 'no_work' } });
    }
  });

  it('answers no harness, and mints nothing, when the worker offers none the Deployment wants', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const token = await f.worker('mem_w');
    const before = (f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get() as { n: number }).n;
    expect(await claimNextRun(f.e.serverEnv, { tokenId: token, machineId: 'm1', harnesses: [{ id: 'claude-code', authenticated: false }], now: NOW + 1 }))
      .toEqual({ claimed: false, reason: 'no_harness' });
    // No harness match is decided before anything is minted, so this one mints nothing at all.
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get()).toEqual({ n: before });
    expect(f.row('run_1').status).toBe('queued');
  });

  it('mints nothing on an idle poll', async () => {
    const f = fixture();
    const token = await f.worker('mem_w');
    const before = (f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get() as { n: number }).n;
    expect(await claimNextRun(f.e.serverEnv, { tokenId: token, machineId: 'm1', harnesses: OFFERED, now: NOW })).toEqual({ claimed: false, reason: 'no_work' });
    expect(f.e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get()).toEqual({ n: before });
  });
});

describe('the prompt a claim hands a worker', () => {
  it('is built again at the claim, so a run reads the vault as it stands when it runs', async () => {
    const f = fixture('extract-curate');
    f.e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`, [NOW]);
    f.queue('run_1', NOW);
    // The dispatch left a prompt on the row; the claim replaces it with one
    // built now, and files the hash the server recorded for it.
    f.e.sqlite.run(`UPDATE agent_runs SET instruction = 'a prompt from the dispatch' WHERE id = 'run_1'`);
    const claimed = await claimNextRun(f.e.serverEnv, { tokenId: await f.worker('mem_w'), machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.instruction).not.toBe('a prompt from the dispatch');
    const row = f.e.sqlite.query(`SELECT instruction, run_context AS runContext FROM agent_runs WHERE id = 'run_1'`).get() as { instruction: string; runContext: string };
    expect(claimed.run.instruction).not.toBeNull();
    expect(row.instruction).toBe(claimed.run.instruction!);
    expect(JSON.parse(row.runContext).input_hash).toEqual(expect.any(String));
  });
});

describe('which harness a claim chooses', () => {
  it('takes the preferred one, then the fallback order, and only what the worker has logged in', () => {
    const offered = [{ id: 'codex', authenticated: true }, { id: 'opencode', authenticated: true }, { id: 'claude-code', authenticated: false }];
    expect(chooseHarness('claude-code', ['codex', 'opencode'], null, offered)).toBe('codex');
    expect(chooseHarness('claude-code', ['opencode'], null, offered)).toBe('opencode');
    // A Deployment that names nothing takes what the worker has, so a machine
    // with a logged-in harness runs work the moment it attaches.
    expect(chooseHarness(null, [], null, offered)).toBe('codex');
    // A Deployment that names only harnesses this worker lacks takes none.
    expect(chooseHarness('claude-code', [], null, offered)).toBeNull();
    // A per-task override is tried ahead of the Deployment's preference.
    expect(chooseHarness('codex', ['codex'], 'opencode', offered)).toBe('opencode');
  });
});

describe('the lease', () => {
  it('returns a run to the queue at expiry and not before, and never lets it be taken twice', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const [ta, tb] = [await f.worker('mem_a'), await f.worker('mem_b')];
    const claimed = await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW });
    expect(claimed.claimed).toBe(true);
    const credential = f.row('run_1').dispatchedBy as string;

    // Before expiry the run is held: the sweep leaves it and a second worker gets nothing.
    expect(await expireLeases(f.e.serverEnv, NOW + WORKER_LEASE_MS - 1)).toBe(0);
    expect(f.row('run_1').status).toBe('running');
    expect(await claimNextRun(f.e.serverEnv, { tokenId: tb, machineId: 'm2', harnesses: OFFERED, now: NOW + WORKER_LEASE_MS - 1 }))
      .toEqual({ claimed: false, reason: 'no_work' });

    // At expiry it returns to the queue, its credential retired with it.
    expect(await expireLeases(f.e.serverEnv, NOW + WORKER_LEASE_MS)).toBe(1);
    expect(f.row('run_1')).toMatchObject({ status: 'queued', leasedBy: null, leaseExpiresAt: null, dispatchedBy: null });
    expect(f.live(credential)?.revoked_at).not.toBeNull();

    // And another worker takes it.
    const again = await claimNextRun(f.e.serverEnv, { tokenId: tb, machineId: 'm2', harnesses: OFFERED, now: NOW + WORKER_LEASE_MS + 1 });
    expect(again.claimed).toBe(true);
    expect(f.row('run_1').leasedBy).toBe(tb);
  });

  it('tells a worker whose lease was swept that it no longer holds the run', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const ta = await f.worker('mem_a');
    await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW });
    expect(await renewLease(f.e.serverEnv, { tokenId: ta, now: NOW + 1 }, { projectId: 'proj_1', runId: 'run_1' }))
      .toEqual({ held: true, expiresAt: NOW + 1 + WORKER_LEASE_MS });
    await expireLeases(f.e.serverEnv, NOW + 1 + WORKER_LEASE_MS);
    expect(await renewLease(f.e.serverEnv, { tokenId: ta, now: NOW + 1 + WORKER_LEASE_MS }, { projectId: 'proj_1', runId: 'run_1' }))
      .toMatchObject({ held: false });
  });

  it('ends a run only for the worker that leases it, and retires the run\'s credential with it', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const ta = await f.worker('mem_a');
    const other = await f.worker('mem_other');
    await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW });
    const credential = f.row('run_1').dispatchedBy as string;
    expect(await endLeasedRun(f.e.serverEnv, { tokenId: other, now: NOW + 5 }, { projectId: 'proj_1', runId: 'run_1', status: 'completed' }))
      .toEqual({ ended: false, reason: 'the lease is no longer held' });
    expect(f.row('run_1').status).toBe('running');
    // The lease is what admits the write; the task's own close rule decides what
    // the row records, and this run left none of the evidence a titling run owes.
    expect(await endLeasedRun(f.e.serverEnv, { tokenId: ta, now: NOW + 5 }, { projectId: 'proj_1', runId: 'run_1', status: 'completed' }))
      .toEqual({ ended: true, status: 'failed' });
    expect((await getRun(f.e.db, SCOPE, 'run_1'))?.status).toBe('failed');
    expect(f.live(credential)?.revoked_at).not.toBeNull();
    // A second ending finds the run already over.
    expect(await endLeasedRun(f.e.serverEnv, { tokenId: ta, now: NOW + 6 }, { projectId: 'proj_1', runId: 'run_1', status: 'failed' }))
      .toMatchObject({ ended: false });
  });

  it('heals a restored lease whose worker is long gone', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    await claimNextRun(f.e.serverEnv, { tokenId: await f.worker('mem_a'), machineId: 'm1', harnesses: OFFERED, now: NOW });
    // A backup carries both lease columns, so a restore can land a lease no
    // worker holds. The next sweep returns the run rather than stranding it.
    expect(await expireLeases(f.e.serverEnv, NOW + WORKER_LEASE_MS * 10)).toBe(1);
    expect(f.row('run_1').status).toBe('queued');
  });

  it('holds the relation between the heartbeat, the lease and the shortest task budget', () => {
    // The numbers are tunable; the relation is not. A lease survives three
    // missed renewals, and expires before a run's own budget can, so the two
    // never answer the same question.
    // Two missed renewals survive; the third is the expiry.
    expect(WORKER_HEARTBEAT_MS * 3).toBeLessThanOrEqual(WORKER_LEASE_MS);
    const shortest = Math.min(...Object.values(TASK_RUN_TIMEOUT_SECONDS)) * 1000;
    expect(WORKER_LEASE_MS).toBeLessThan(shortest + RUN_OVERRUN_MARGIN_MS);
  });
});

describe('what an operator reads', () => {
  it('counts the workers driving a run and the runs still waiting, and stops counting a worker that finished', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    f.queue('run_2', NOW + 1);
    const ta = await f.worker('mem_a');
    expect(await workerLiveness(f.e.db, NOW)).toEqual({ workersBusy: 0, runsQueued: 2 });
    await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW });
    expect(await workerLiveness(f.e.db, NOW + 1)).toEqual({ workersBusy: 1, runsQueued: 1 });
    // A lease nobody renews stops counting.
    expect(await workerLiveness(f.e.db, NOW + WORKER_LEASE_MS + 1)).toEqual({ workersBusy: 0, runsQueued: 1 });
  });

  it('stops counting a worker the moment its run ends, rather than until the lease would have lapsed', async () => {
    const f = fixture();
    f.queue('run_1', NOW);
    const ta = await f.worker('mem_a');
    await claimNextRun(f.e.serverEnv, { tokenId: ta, machineId: 'm1', harnesses: OFFERED, now: NOW });
    expect(await workerLiveness(f.e.db, NOW + 1)).toEqual({ workersBusy: 1, runsQueued: 0 });
    expect(await endLeasedRun(f.e.serverEnv, { tokenId: ta, now: NOW + 2 }, { projectId: 'proj_1', runId: 'run_1', status: 'completed' }))
      .toMatchObject({ ended: true });
    expect(await workerLiveness(f.e.db, NOW + 3)).toEqual({ workersBusy: 0, runsQueued: 0 });
    expect(f.row('run_1')).toMatchObject({ leasedBy: null, leaseExpiresAt: null });
  });
});
