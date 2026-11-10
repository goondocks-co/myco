/**
 * A run's report through the container's route is held to the same rule as the
 * MCP tool: an action the run's task cannot close under is refused, naming the
 * actions it can, and leaves no report row. The MCP door's refusal is asserted
 * beside the run tools.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { acceptedActions, unacceptedActionError } from '@myco-server-worker/core/run-postconditions.js';
import { issueMemberToken } from './helpers/member-token.js';
import { memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';

const TASK = 'embedding-reconcile';

async function runningRun() {
  const f = sqliteEnv();
  const now = Date.now();
  turnOnGatedCapabilities(f.sqlite);
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  const holder = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'machine_1' }, now);
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'run_1', agentId: 'myco-agent', task: TASK, provider: null, model: null,
    runContext: JSON.stringify({ timeoutSeconds: 120 }), startedAt: now, dispatchedBy: holder.tokenId, dryRun: true });
  f.sqlite.run("UPDATE agent_runs SET status = 'running' WHERE id = 'run_1'");
  const report = async (action: string) => {
    const response = await worker.fetch(memberPost(holder.token, { runId: 'run_1', agentId: 'myco-agent', action, summary: 'done' }, '/runs/report'), f.env);
    return await response.json() as Record<string, unknown>;
  };
  const reports = () => f.sqlite.query("SELECT action FROM agent_reports WHERE run_id = 'run_1'").all();
  return { f, report, reports };
}

describe('a report on the run route', () => {
  it('refuses an action its task cannot close under, naming the ones it can, and records nothing', async () => {
    const { f, report, reports } = await runningRun();
    try {
      const accepted = acceptedActions(TASK)!;
      const outside = 'extract';
      expect(accepted).not.toContain(outside);
      const answer = await report(outside);
      expect(answer).toMatchObject({ persisted: false, reason: unacceptedActionError(TASK, accepted) });
      expect(reports()).toEqual([]);
    } finally { f.sqlite.close(); }
  });

  it('records an action its task closes under', async () => {
    const { f, report, reports } = await runningRun();
    try {
      const [action] = acceptedActions(TASK)!;
      expect(await report(action!)).toMatchObject({ persisted: true, recorded: true });
      expect(reports()).toEqual([{ action }]);
    } finally { f.sqlite.close(); }
  });
});
