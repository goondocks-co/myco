import { expect } from 'bun:test';
import { REPOSITORY_FAILURE_FEATURE, WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { FEATURES_HEADER, featureAdvertised } from '@goondocks/myco-shared/member-protocol';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.js';
import { lit, MEMBER_ID, type ParityScenario } from '../harness.ts';

export const repositoryFailure: ParityScenario = {
  name: 'repository preparation failure: leased worker metadata reaches runs and work on both targets',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    const now = Date.now();
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${target.url}${path}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(featureAdvertised(response.headers.get(FEATURES_HEADER), REPOSITORY_FAILURE_FEATURE)).toBe(true);
      return response.json() as Promise<Record<string, any>>;
    };
    const read = async (path: string) => {
      const response = await fetch(`${target.url}${path}`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, any>>;
    };
    const configured = await fetch(`${target.url}/api/settings/agent.harnesses.claude-code.credential`, {
      method: 'PUT', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'worker-login' }),
    });
    expect(configured.status).toBe(200);
    await target.sql(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,${now})`);
    await target.sql(`INSERT INTO project_capabilities (project_id,capability,enabled,updated_at,updated_by)
      VALUES (${lit(target.projectId)},'vault_evolution',1,${now},${lit(MEMBER_ID)})`);
    await target.sql(`INSERT INTO project_repositories (project_id,revision,url,branch,username,secret_slot,updated_at,updated_by)
      VALUES (${lit(target.projectId)},'repository-failure',${lit('https://github.com/example/source.git')},'main',NULL,NULL,${now},${lit(MEMBER_ID)})`);

    const cases = [
      { suffix: 'reason', reason: { code: 'fetch_failed', summary: 'fatal: unable to access https://reader:synthetic-secret-999@github.com/example/source.git' } },
      { suffix: 'old', reason: undefined },
      { suffix: 'invalid', reason: { code: 'worker_supplied_reason', summary: 'private detail' } },
    ];
    for (const [index, entry] of cases.entries()) {
      const runId = `repository-failure-${entry.suffix}`;
      await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
        VALUES (${lit(target.projectId)},${lit(runId)},'myco-agent','vault-seed','queued',${now + index},'worker',${lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID }))},'{}')`);
      const claimed = await post('/worker/claim', { harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES });
      expect(claimed).toMatchObject({ persisted: true, claimed: true, run: { id: runId } });
      const ended = await post('/worker/end', {
        projectId: target.projectId, runId, attemptId: claimed.run.attemptId, status: 'failed',
        error: 'the worker failed while driving the run (repository_unprepared)',
        ...(entry.reason === undefined ? {} : { repositoryFailure: entry.reason }),
      });
      expect(ended).toMatchObject({ persisted: true, ended: true });
      const detail = await read(`/api/projects/${target.projectId}/runs/${runId}`);
      expect(detail.run.errorCode).toBe('repository_unprepared');
      const work = await read(`/api/work?project=${target.projectId}&since=${now - 1000}&until=${Date.now() + 10_000}`);
      const failure = work.runs.find((run: { id: string }) => run.id === runId)?.failure;
      expect(failure?.code).toBe('repository_unprepared');
      if (entry.reason?.code === 'fetch_failed') expect(failure?.repositoryFailure).toEqual(detail.run.repositoryFailure);
      else expect(failure?.repositoryFailure).toBeUndefined();
      if (entry.reason?.code === 'fetch_failed') {
        expect(detail.run.repositoryFailure).toMatchObject({ code: 'fetch_failed', summary: expect.stringContaining('fatal:') });
        expect(JSON.stringify({ detail, work })).not.toContain('synthetic-secret-999');
        expect(JSON.stringify({ detail, work })).not.toContain('reader:');
      } else expect(detail.run.repositoryFailure).toBeUndefined();
    }
  },
};
