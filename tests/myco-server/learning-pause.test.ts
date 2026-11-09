import { expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { claimNextRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { claimQueuedRun } from '@myco-server-worker/core/worker-claim.js';
import { nextClaimable } from '@myco-server-worker/db/runs/queue.js';
import { HARNESS_MEMBER_ID, WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { PROFILE_HARNESSES } from '@goondocks/myco-shared/execution-profile';

const NOW = 1_800_000_000_000;
const OFFERS = [offeredHarness('claude-code')];
const PROFILE = { tier: 'default' as const, model: PROFILE_HARNESSES['claude-code'].models.default!, effort: null, sources: { tier: 'task' as const, model: 'default' as const } };

async function fixture(options: Parameters<typeof sqliteEnv>[0] = {}) {
  const f = sqliteEnv({ workerLogin: true, ...options });
  await ensureMember(f.db, HARNESS_MEMBER_ID, NOW, 'member');
  await ensureMember(f.db, 'mem_worker', NOW, 'admin');
  const token = await issueMemberToken(f.db, { memberId: 'mem_worker', machineId: 'machine' }, NOW);
  const principal = legacyWorker(token.tokenId, 'machine');
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,?)", [NOW]);
  const queue = (id: string, task = 'extract-curate') => f.sqlite.run(
    `INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,run_context)
     VALUES('proj_1',?,'myco-agent',?,'queued',?,'legacy input',?,'{"timeoutSeconds":900}')`,
    [id, task, NOW, JSON.stringify({ serverUrl: 'https://example.test', params: { session_id: 'session', mode: 'claim' } })]);
  const claimThin = async () => {
    const claimed = await claimQueuedRun(f.serverEnv, (await nextClaimable(f.db, []))!, {
      worker: principal, harness: 'claude-code', now: NOW + 1, leaseExpiresAt: NOW + 1 + WORKER_LEASE_MS, profile: PROFILE,
    });
    return claimed === null ? { claimed: false as const } : { claimed: true as const, run: { attemptId: claimed.issued.tokenId } };
  };
  return { ...f, principal, queue, claimThin, worker: { principal, harnesses: OFFERS, now: NOW + 1 } };
}

it('never schedules learning on the clock', async () => {
  const f = await fixture();
  try {
    expect(TASK_SCHEDULE['extract-curate']).toBeNull();
    await runScheduledTasks(f.serverEnv, 'idle', NOW, 'https://example.test');
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate'").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); }
});

it('leaves a replaced attempt and both credentials untouched when the lapse snapshot is stale', async () => {
  let armed = false;
  let fired = false;
  let replacementId = '';
  let swappedRun: unknown;
  const f = await fixture({ onSql: (sql, sqlite) => {
    if (!armed || !sql.startsWith('UPDATE agent_runs SET status = CASE')) return;
    armed = false;
    fired = true;
    sqlite.run("UPDATE agent_runs SET dispatched_by=? WHERE id='replaced'", [replacementId]);
    swappedRun = sqlite.query("SELECT * FROM agent_runs WHERE id='replaced'").get();
  } });
  try {
    f.queue('replaced');
    const claim = await f.claimThin();
    if (!claim.claimed) throw new Error('the pre-pause extraction did not acquire its lease');
    replacementId = (await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW + 2)).tokenId;
    const credentials = () => f.sqlite.query('SELECT id,revoked_at FROM member_credentials WHERE id IN (?,?) ORDER BY id').all(claim.run.attemptId, replacementId);
    const beforeCredentials = credentials();
    expect(beforeCredentials).toEqual([claim.run.attemptId, replacementId].sort().map(id => ({ id, revoked_at: null })));
    const attempts = f.sqlite.query("SELECT * FROM agent_run_attempts WHERE run_id='replaced'").all();
    armed = true;
    const settled = await expireLeases(f.serverEnv, NOW + WORKER_LEASE_MS * 2);
    expect(fired).toBe(true);
    expect({ settled, run: f.sqlite.query("SELECT * FROM agent_runs WHERE id='replaced'").get(), credentials: credentials(), attempts: f.sqlite.query("SELECT * FROM agent_run_attempts WHERE run_id='replaced'").all() })
      .toEqual({ settled: 0, run: swappedRun, credentials: beforeCredentials, attempts });
  } finally { f.sqlite.close(); }
});
