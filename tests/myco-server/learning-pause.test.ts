import { recordReport } from '@myco-server-worker/core/run-postconditions.js';
import { expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken, mintInsert, NO_RUNTIME_CLAIMS } from '@myco-server-worker/auth/tokens.js';
import { claimNextRun, expireLeases, renewLease, dispatchTask, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { claimQueuedRun, nextClaimable, workerClaimAdmission, NO_LIMITS } from '@myco-server-worker/core/runs.js';
import { HARNESS_MEMBER_ID, WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { PROFILE_HARNESSES } from '@goondocks/myco-shared/execution-profile';
import { LEARNING_PAUSE_MESSAGE } from '@myco-server-worker/core/task-catalogue.js';
import { dispatchRefusalMessage } from '@myco-server-worker/core/harness.js';

const NOW = 1_800_000_000_000;
const OFFERS = [offeredHarness('claude-code')];

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
  return { ...f, principal, queue, worker: { principal, harnesses: OFFERS, now: NOW + 1 } };
}

it('refuses clock and hand learning without creating a run', async () => {
  const f = await fixture();
  try {
    expect(TASK_SCHEDULE['extract-curate']).toBeNull();
    expect(await dispatchTask(f.serverEnv, 'extract-curate', 'proj_1', { serverUrl: 'https://example.test', actor: 'owner' }, NOW))
      .toMatchObject({ dispatched: false, refusal: 'not_landed' });
    expect(dispatchRefusalMessage('not_landed', 'extract-curate')).toBe(LEARNING_PAUSE_MESSAGE);
    await runScheduledTasks(f.serverEnv, 'idle', NOW, 'https://example.test');
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate'").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); }
});

it('skips extraction stragglers before input and claims the following title with its own instruction', async () => {
  const f = await fixture();
  try {
    f.queue('paused');
    f.queue('title', 'title-summary');
    const claimed = await claimNextRun(f.serverEnv, f.worker);
    expect(claimed).toMatchObject({ claimed: true, run: { id: 'title', task: 'title-summary' } });
    if (claimed.claimed) expect(claimed.run.instruction).toContain('Title and summarize');
    expect(f.sqlite.query("SELECT status,run_context FROM agent_runs WHERE id='paused'").get())
      .toEqual({ status: 'skipped', run_context: '{"reason":"learning_paused"}' });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id='paused'").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); }
});

it('fences a prepared claim before queued cleanup and permits the low-level claim after resume', async () => {
  const f = await fixture();
  try {
    f.sqlite.run("DELETE FROM schema_meta WHERE key='learning_paused_at'");
    f.queue('race');
    const candidate = (await nextClaimable(f.db, []))!;
    const admission = { limits: NO_LIMITS, now: NOW + 1 };
    f.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_paused_at','1')");
    const profile = { tier: 'default' as const, model: PROFILE_HARNESSES['claude-code'].models.default!, effort: null, sources: { tier: 'task' as const, model: 'default' as const } };
    const claim = () => claimQueuedRun(f.serverEnv, candidate, {
      worker: f.principal, harness: 'claude-code', now: NOW + 1,
      leaseExpiresAt: NOW + WORKER_LEASE_MS, profile,
    });
    expect(await claim()).toBeNull();
    expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='race'").get()).toEqual({ status: 'queued' });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_attempts").get()).toEqual({ n: 0 });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM member_credentials WHERE member_id=? AND revoked_at IS NULL").get(HARNESS_MEMBER_ID))
      .toEqual({ n: 0 });
    expect(await claimNextRun(f.serverEnv, f.worker)).toMatchObject({ claimed: false });
    expect(f.sqlite.query("SELECT status,run_context FROM agent_runs WHERE id='race'").get())
      .toEqual({status:'skipped',run_context:'{"reason":"learning_paused"}'});
    f.sqlite.run("UPDATE agent_runs SET status='queued' WHERE id='race'");
    f.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_resumed_at','2')");
    expect(await claim()).toMatchObject({ row:{id: 'race'} });
  } finally { f.sqlite.close(); }
});

it('fails a paused lapsed extraction exactly once and retains its original attempt', async () => {
  const f = await fixture();
  try {
    f.sqlite.run("DELETE FROM schema_meta WHERE key='learning_paused_at'");
    f.queue('held');
    const claimed = await claimNextRun(f.serverEnv, f.worker);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) throw new Error('pre-pause fixture did not claim');
    f.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_paused_at','1')");
    expect(await renewLease(f.serverEnv, { principal: f.principal, now: NOW + 2 }, { projectId: 'proj_1', runId: 'held', attemptId: claimed.run.attemptId }))
      .toMatchObject({ held: true });
    const expiry = NOW + WORKER_LEASE_MS * 2;
    expect(await expireLeases(f.serverEnv, expiry)).toBe(1);
    for (let poll = 0; poll < 3; poll++) {
      expect(await claimNextRun(f.serverEnv, { ...f.worker, now: expiry + poll })).toMatchObject({ claimed: false });
      expect(await expireLeases(f.serverEnv, expiry + poll)).toBe(0);
    }
    expect(f.sqlite.query("SELECT status,error_code,dispatched_by FROM agent_runs WHERE id='held'").get())
      .toEqual({ status: 'failed', error_code: 'learning_paused', dispatched_by: claimed.run.attemptId });
    expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id='held'").get()).toEqual({ n: 1 });
    expect(f.sqlite.query("SELECT revoked_at FROM member_credentials WHERE id=?").get(claimed.run.attemptId))
      .toEqual({ revoked_at: expiry });
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
    f.sqlite.run("DELETE FROM schema_meta WHERE key='learning_paused_at'");
    f.queue('replaced');
    const claim = await claimNextRun(f.serverEnv, f.worker);
    if (!claim.claimed) throw new Error('the pre-pause extraction did not acquire its lease');
    replacementId = (await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW + 2)).tokenId;
    f.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_paused_at','1')");
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

it('allows an extraction already under lease to report and complete during the pause', async () => {
  const f=await fixture();
  try {
    f.sqlite.run("DELETE FROM schema_meta WHERE key='learning_paused_at'");
    f.queue('finishing');
    const claim=await claimNextRun(f.serverEnv,f.worker);
    if(!claim.claimed) throw new Error('the pre-pause extraction did not acquire its lease');
    f.sqlite.run("INSERT INTO schema_meta(key,value) VALUES('learning_paused_at','1')");
    expect(await recordReport(f.db,{projectId:'proj_1'},{
      runId:'finishing',agentId:'myco-agent',action:'skip',summary:'No eligible prompts remain',details:null,createdAt:NOW+2,
      audit:{steps:['Read eligible prompts'],examined:[],commands:[],failures:[],reasoning:'The Project has no unread extraction material'},
    })).toMatchObject({recorded:true,auditError:null});
    expect(await endLeasedRun(f.serverEnv,{principal:f.principal,now:NOW+3},{
      projectId:'proj_1',runId:'finishing',attemptId:claim.run.attemptId,status:'completed',
    })).toEqual({ended:true,status:'completed'});
  } finally {f.sqlite.close();}
});
