import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';

export const learningPause: ParityScenario = {
  name: 'learning pause: queued stragglers cannot acquire attempts, and resumed learning queues a hand start',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    expect((await target.sql("SELECT value FROM schema_meta WHERE key='learning_paused_at'")).length).toBe(1);
    const resumed = await target.sql("SELECT value FROM schema_meta WHERE key='learning_resumed_at'") as { value: string }[];
    expect(resumed.length).toBe(1);
    // The pause window, before whole-session learning resumes.
    await target.sql("DELETE FROM schema_meta WHERE key='learning_resumed_at'");
    await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)");
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec)
      VALUES(${lit(target.projectId)},'pause-straggler','myco-agent','extract-curate','queued',${Date.now()},'no new thin instruction','{}')`);
    const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: owner, body: '{}' });
    expect(wake.status).toBe(200);
    expect(await target.sql("SELECT status,run_context FROM agent_runs WHERE id='pause-straggler'"))
      .toEqual([{ status: 'skipped', run_context: '{"reason":"learning_paused"}' }]);
    expect(await target.sql("SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id='pause-straggler'")).toEqual([{ n: 0 }]);
    await target.sql(`INSERT INTO schema_meta(key,value) VALUES('learning_resumed_at',${lit(resumed[0]!.value)})`);
    const response = await fetch(`${target.url}/api/harness/dispatch`, {
      method: 'POST', headers: owner, body: JSON.stringify({ task: 'extract-curate', projectId: target.projectId }),
    });
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200, body: { queued: true, task: 'extract-curate' } });
  },
};
