import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { documentsPublished, expectPersisted, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** Coverage follows the exact items served over each front door. */
export const extractionCoverage: ParityScenario = {
  name: 'extraction coverage: learning completions, late material and acknowledgements survive run deletion',
  dedicated: { cloudflare: {}, timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const now = Date.now();
    const project = target.projectId;
    const session = 'coverage-session';
    const first = crypto.randomUUID();
    const tied = crypto.randomUUID();
    const hole = crypto.randomUUID();
    const capture = async (kind: string, at: number, payload: Record<string, unknown>, source = session) => {
      await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: source, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }) }), kind);
    };
    const prompt = (promptId: string, at: number) => capture('prompt', at, { promptId, text: 'Material to extract', origin: 'user' });
    // A session's end is captured, then the wake publishes the prompts an acknowledgement is checked against.
    const complete = async () => { await capture('session.end', now, { endedAt: now }); await documentsPublished(target, session); };
    const acknowledged = async (n: number) => expect(await target.sql(`SELECT COUNT(*) AS n FROM extraction_acks WHERE project_id=${lit(project)} AND session_id=${lit(session)} AND kind='record'`)).toEqual([{ n }]);
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES('mem_harness','Coverage',${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,${now})`);
    const run = async (id: string, ids: string[]) => {
      const tokenId = `mt_${id}`;
      const token = `${id}-synthetic-credential`.padEnd(43, 'x');
      await target.sql(`INSERT OR IGNORE INTO learning_sessions(project_id,session_id,init_state) VALUES(${lit(project)},${lit(session)},'ready')`);
      await target.sql(`UPDATE learning_sessions SET init_state='ready' WHERE project_id=${lit(project)} AND session_id=${lit(session)}`);
      for (const promptId of ids) await target.sql(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,input_hash,card,signal,records,last_seq,created_at,carded_at)
        VALUES(${lit(project)},${lit(session)},${lit(promptId)},'carded',${lit(id+':'+promptId)},'fixture card','high',${lit(JSON.stringify([['prompt',promptId]]))},1,1,${now})
        ON CONFLICT(project_id,session_id,turn_key) DO UPDATE SET state='carded',input_hash=excluded.input_hash,records=excluded.records,covered=0`);
      const revision = (await target.sql(`SELECT revision FROM learning_sessions WHERE project_id=${lit(project)} AND session_id=${lit(session)}`))[0]!.revision;
      const assignment = { kind: 'learning', expectedRevision: revision, turns: ids.map(turnKey => ({turnKey,inputHash:id+':'+turnKey})), more: false, handoff: null };
      await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
        VALUES(${lit(tokenId)},'mem_harness','coverage',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
        VALUES(${lit(project)},${lit(id)},'myco-agent','extract-curate','running',${now},${lit(tokenId)},${lit(JSON.stringify({ timeoutSeconds: 300, session_id: session, assignment }))})`);
      return async (args: Record<string, unknown>) => {
        const response = await fetch(`${target.url}/mcp`, { method: 'POST', headers: memberHeadersFor(token, project, { 'content-type': 'application/json' }),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_learning', arguments: { project, ...args } } }) });
        const body = await response.json() as { result?: { structuredContent: { result: any } }; error?: unknown };
        expect(body.error).toBeUndefined();
        return body.result!.structuredContent.result;
      };
    };
    await prompt(first, now - 1000);
    await prompt(tied, now - 1000);
    await complete();
    const one = await run('coverage-one', [first]);
    expect(await one({ op: 'complete' })).toMatchObject({ ok: false });
    await one({ op: 'material' });
    expect(await one({ op: 'complete', handoff: 'read the remaining cards' })).toEqual({ completed: true, covered: 1 });
    expect(await one({ op: 'complete' })).toMatchObject({ ok: false });
    await acknowledged(1);
    await prompt(hole, now - 2000);
    await complete();
    await acknowledged(1);
    const two = await run('coverage-two', [hole, tied]);
    await two({ op: 'material' });
    expect(await two({ op: 'complete' })).toEqual({ completed: true, covered: 2 });
    expect((await target.sql(`SELECT served_id FROM extraction_acks WHERE project_id=${lit(project)} AND record_id=${lit(hole)}`))[0]!.served_id).toEqual(expect.any(String));
    await acknowledged(3);
    expect((await target.sql('SELECT COUNT(*) AS n FROM session_prompts'))[0]!.n).toBeGreaterThan(0);
    await target.sql(`DELETE FROM agent_runs WHERE project_id=${lit(project)} AND id IN ('coverage-one','coverage-two')`);
    expect(await target.sql('SELECT COUNT(*) AS n FROM extraction_acks')).toEqual([{ n: 3 }]);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{ n: 0 }]);
    await acknowledged(3);
  },
};
