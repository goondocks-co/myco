import { HELD_BY_WORDS } from '@goondocks/myco-shared/run-holds';
import { expect } from 'bun:test';
import { lit, MEMBER_ID, type ParityScenario } from '../harness.ts';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.js';
import { revisionHeaders } from '../settings-revision.ts';

export const runHeads: ParityScenario = {
  name: 'claim heads: exact queue counts, guarded capacity and head holds',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    const now = Date.now(), project = lit(target.projectId);
    const headers = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    for (const [leaf, value] of [['agent.limits.concurrent_runs', 1], ['agent.harnesses.claude-code.credential', 'worker-login']] as const) {
      expect((await fetch(`${target.url}/api/settings/${leaf}`, { method: 'PUT', headers: { ...headers, ...await revisionHeaders(target, `/api/settings/${leaf}`) }, body: JSON.stringify({ value }) })).status).toBe(200);
    }
    await target.sql("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Agent','built-in',1,1)");
    const spec = lit(JSON.stringify({ serverUrl: target.url, actor: MEMBER_ID, params: { session_id: 'head-session', mode: 'claim' }, timeoutSeconds: 300 }));
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,origin) VALUES
      (${project},'z-first','myco-agent','title-summary','queued',${now},'fixture input',${spec},'manual'),
      (${project},'a-second','myco-agent','title-summary','queued',${now + 1},'fixture input',${spec},'manual')`);
    const head = () => target.sql(`SELECT queued_count,oldest_run_id FROM task_runtime WHERE project_id=${project} AND task='title-summary'`);
    expect(await head()).toEqual([{ queued_count: 2, oldest_run_id: 'z-first' }]);
    const claim = async () => {
      const response = await fetch(`${target.url}/worker/claim`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ harnesses: [offeredHarness('claude-code')] }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await claim()).toMatchObject({ claimed: true, run: { id: 'z-first' } });
    expect(await claim()).toMatchObject({ claimed: false, reason: 'at_limit' });
    expect(await head()).toEqual([{ queued_count: 1, oldest_run_id: 'a-second' }]);
    const today=await fetch(`${target.url}/api/work/now?project=${target.projectId}`,{headers:target.ownerHeaders()});
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({waiting:expect.arrayContaining([
      expect.objectContaining({count:1,why:HELD_BY_WORDS.concurrent_runs}),
    ])});
    expect(await target.sql("SELECT live,queued FROM admission_contribution WHERE scope='fleet' AND scope_key=''"))
      .toEqual([{ live: 1, queued: 1 }]);
    await target.sql(`UPDATE agent_runs SET status='completed',completed_at=${now + 2} WHERE project_id=${project} AND id='z-first'`);
    expect(await claim()).toMatchObject({ claimed: true, run: { id: 'a-second' } });
    expect(await head()).toEqual([{ queued_count: 0, oldest_run_id: null }]);
    await target.sql(`UPDATE agent_runs SET status='completed',completed_at=${now + 3} WHERE project_id=${project} AND id='a-second'`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at,instruction,dispatch_spec,origin)
      VALUES(${project},'race','myco-agent','title-summary','queued',${now + 4},'fixture input',${spec},'manual')`);
    const raced = await Promise.all([claim(), claim()]);
    expect(raced.filter(result => result !== null && typeof result === 'object' && 'claimed' in result && result.claimed === true)).toHaveLength(1);
    expect(await target.sql(`SELECT run_id FROM agent_run_attempts WHERE project_id=${project} AND run_id='race'`)).toEqual([{ run_id: 'race' }]);
    const snapshot = async () => Promise.all(['run_live', 'task_due', 'task_runtime', 'admission_contribution'].map(table =>
      target.sql(`SELECT * FROM ${table} ORDER BY 1,2`)));
    const settled = await snapshot();
    expect(await claim()).toMatchObject({ claimed: false });
    expect(await snapshot()).toEqual(settled);
  },
};
