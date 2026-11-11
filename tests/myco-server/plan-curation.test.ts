import { afterEach, describe, expect, it } from 'bun:test';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, dispatchTask, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { savePlan } from '@myco-server-worker/core/plans.js';
import { reportSessionArtifact } from '@myco-server-worker/core/session-artifacts.js';
import { PLAN_CURATION_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { PLAN_CURATION_STALE_MS } from '@myco-server-worker/core/plan-curation.js';
import { RUN_CLOSE_ARTIFACT_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { issueMemberToken } from './helpers/member-token.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';

const ORIGIN = 'https://s';
const NOW = 1_800_000_000_000;
const STALE = NOW - PLAN_CURATION_STALE_MS - 86_400_000;
const scope = { projectId: 'proj_1' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

/**
 * A Project with two plans nobody has touched for longer than curation waits: `writer`, whose session launched a
 * session that reported pull request 2180, and `idle`, whose session reported nothing.
 */
async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  cleanups.push(() => e.sqlite.close());
  await ensureMember(e.db, 'mem_worker', STALE, 'admin', 'worker');
  const member = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, STALE);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [STALE]);
  e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id,name,created_at) VALUES ('proj_1','proj_1',?)`, [STALE]);
  e.sqlite.run(`INSERT INTO project_capabilities (project_id,capability,enabled,updated_at,updated_by) VALUES ('proj_1','spore_curation',1,?,'test')`, [STALE]);
  e.sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,launch_parent_session_id)
    VALUES('proj_1','planning','m1',?1,?2,?2,NULL),('proj_1','landing','m1',?1,?2,?2,'planning'),('proj_1','quiet','m1',?1,?2,?2,NULL)`, [member.tokenId, STALE]);
  const save = async (sessionId: string, planKey: string, title: string, content: string) => {
    const saved = await savePlan(e.serverEnv, { machineId: 'm1', tokenId: member.tokenId }, scope, { sessionId, planKey, title, content }, STALE);
    if (!saved.ok) throw new Error(saved.error);
    return saved.row.planKey;
  };
  const ids = {
    writer: await save('planning', 'writer', 'Plan writer revert', '- [x] one writer\n- [ ] board revert'),
    idle: await save('quiet', 'idle', 'Quiet cache sweep', '- [ ] sweep the cache'),
  };
  expect(await reportSessionArtifact(e.db, scope, { sessionId: 'landing', kind: 'pr', artifactId: '2180', url: 'https://example.test/repo/pull/2180', author: 'mem_worker', reportedAt: STALE + 1 }))
    .toMatchObject({ outcome: 'created' });

  const call = async (token: string, name: string, input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
    }), e.env);
    const body = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    if (body.error !== undefined) return { failed: body.error.message } as Record<string, unknown>;
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  };
  const workerToken = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW);
  const principal = legacyWorker(workerToken.tokenId, 'm1');
  const claimCuration = async () => {
    expect(await dispatchTask(e.serverEnv, PLAN_CURATION_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_worker' }, NOW)).toMatchObject({ dispatched: true, queued: true });
    const claimed = await claimNextRun(e.serverEnv, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now: NOW + 1 });
    if (!claimed.claimed) throw new Error(`the curation run was not claimed: ${claimed.reason}`);
    return claimed.run;
  };
  const end = async (runId: string) => {
    await endLeasedRun(e.serverEnv, { principal, now: NOW + 3 }, { projectId: 'proj_1', runId, status: 'completed' });
    return getRun(e.db, scope, runId);
  };
  return { e, member, ids, call, claimCuration, end };
}

describe('plan curation', () => {
  it('resolves a plan whose session landed a pull request as completed citing it, keeps a plan with no evidence open, and the board can revert it', async () => {
    const r = await rig();
    const run = await r.claimCuration();
    expect(run.instruction).toContain('"pr:2180"');
    const resolve = (input: Record<string, unknown>) => r.call(run.runToken, 'myco_run_plans', { op: 'resolve', ...input });

    const uncited = await resolve({ plan_id: r.ids.idle, decision: 'completed', note: 'Swept.', evidence: [] });
    expect(uncited).toEqual({ ok: false, error: expect.stringContaining('a completed decision cites 0 evidence ids; it cites at least 1') });
    expect(uncited.error).toContain(`Next call: myco_run_plans {"op":"resolve","plan_id":"${r.ids.idle}"}`);
    const borrowed = await resolve({ plan_id: r.ids.idle, decision: 'completed', note: 'Swept.', evidence: ['pr:2180'] });
    expect(borrowed).toEqual({ ok: false, error: expect.stringContaining('evidence ["pr:2180"] is not listed for this plan') });

    expect(await resolve({ plan_id: r.ids.writer, decision: 'completed', note: 'Landed #2180: one plan writer.', evidence: ['pr:2180'] }))
      .toEqual({ resolved: true, plan_id: r.ids.writer, decision: 'completed', remaining: [r.ids.idle], next: { tool: 'myco_run_plans', op: 'resolve', plan_id: r.ids.idle } });
    expect(await resolve({ plan_id: r.ids.idle, decision: 'open', note: 'The cache sweep is still pending.' }))
      .toMatchObject({ resolved: true, remaining: [], next: { tool: 'myco_run', op: 'report' } });
    expect(await r.call(run.runToken, 'myco_run', { op: 'report', action: 'curated', summary: 'One completed, one open.', audit: RUN_AUDIT })).toMatchObject({ recorded: true });
    expect(await r.end(run.id)).toMatchObject({ status: 'completed' });

    const token = r.member.token;
    expect(await r.call(token, 'myco_plans', { op: 'get', id: r.ids.writer }))
      .toMatchObject({ status: 'completed', resolution: { note: 'Landed #2180: one plan writer.', superseded_by: null, evidence: ['pr:2180'] } });
    expect(await r.call(token, 'myco_plans', { op: 'get', id: r.ids.idle })).toMatchObject({ status: 'active', resolution: { resolved_at: null } });

    // The past plan is found by the words of its outcome, and its hit reads that outcome.
    const found = await r.call(token, 'myco_search', { query: 'landed', type: 'plan', mode: 'fts' }) as { hits: Array<{ id: string; preview: string }> };
    expect(found.hits.map(hit => hit.id)).toEqual([r.ids.writer]);
    expect(found.hits[0]!.preview).toMatch(/^Completed \d{4}-\d{2}-\d{2}: Landed #2180: one plan writer\.$/);

    expect(await r.call(token, 'myco_plans', { op: 'save', id: r.ids.writer, status: 'active', session_id: 'planning', project: 'proj_1' })).toMatchObject({ ok: true, status: 'active' });
    const reverted = await r.call(token, 'myco_plans', { op: 'get', id: r.ids.writer });
    expect({ status: reverted.status, resolution: reverted.resolution }).toEqual({ status: 'active', resolution: undefined });
  });

  it('closes a run that recorded no decision as failed, and leaves every plan as it was', async () => {
    const r = await rig();
    const run = await r.claimCuration();
    expect(await r.call(run.runToken, 'myco_run', { op: 'report', action: 'curated', summary: 'Nothing decided.', audit: RUN_AUDIT })).toMatchObject({ recorded: true });
    expect(await r.end(run.id)).toMatchObject({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });
    for (const id of [r.ids.writer, r.ids.idle]) expect(await r.call(r.member.token, 'myco_plans', { op: 'get', id })).toMatchObject({ status: 'active' });
  });

  it('counts every Markdown task list item outside fenced examples as plan progress', async () => {
    const r = await rig();
    const content = ['- [x] dash', '* [ ] star', '+ [X] plus', '1. [ ] ordered', '12) [x] parenthesis', '```', '- [ ] an example', '```', '  - [ ] nested', '- [] not an item'].join('\n');
    expect(await savePlan(r.e.serverEnv, { machineId: 'm1', tokenId: r.member.tokenId }, scope, { sessionId: 'quiet', planKey: 'markdown', title: 'Markdown', content }, NOW))
      .toMatchObject({ ok: true, row: { progress: '3/6' } });
  });
});
