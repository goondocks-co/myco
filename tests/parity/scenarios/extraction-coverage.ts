import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { documentsPublished, expectPersisted, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** Coverage follows the exact items served over each front door. */
export const extractionCoverage: ParityScenario = {
  name: 'extraction coverage: served item acks, late material and counters survive run deletion',
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
    const count = async (n: number) => expect(await target.sql(`SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id=${lit(project)} AND session_id=${lit(session)}`)).toEqual([{ n }]);
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES('mem_harness','Coverage',${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,${now})`);
    const run = async (id: string, startedAt = now) => {
      const tokenId = `mt_${id}`;
      const token = `${id}-synthetic-credential`.padEnd(43, 'x');
      await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
        VALUES(${lit(tokenId)},'mem_harness','coverage',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
        VALUES(${lit(project)},${lit(id)},'myco-agent','extract-curate','running',${startedAt},${lit(tokenId)},${lit(JSON.stringify({ timeoutSeconds: 300 }))})`);
      return async (args: Record<string, unknown>) => {
        const response = await fetch(`${target.url}/mcp`, { method: 'POST', headers: memberHeadersFor(token, project, { 'content-type': 'application/json' }),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_prompts', arguments: { project, ...args } } }) });
        const body = await response.json() as { result?: { structuredContent: { result: any } }; error?: unknown };
        expect(body.error).toBeUndefined();
        return body.result!.structuredContent.result;
      };
    };
    await prompt(first, now - 1000);
    await prompt(tied, now - 1000);
    await complete();
    const one = await run('coverage-one');
    expect(await one({ op: 'mark_processed', prompt_id: first })).toMatchObject({ ok: false });
    const serve = async (runId:string,ids:readonly string[]) => {
      await target.sql(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at)
        SELECT ${lit(project)},${lit(runId)}||':'||value,${lit(runId)},${lit(session)},value,${now} FROM json_each(${lit(JSON.stringify(ids))})`);
    };
    await serve('coverage-one',[first,tied]);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{n:2}]);
    const servedId = 'coverage-one:'+first;
    expect(await one({op:'mark_processed',served_id:servedId})).toMatchObject({marked:true});
    expect(await one({op:'mark_processed',served_id:servedId})).toMatchObject({marked:false});
    await count(1);
    await prompt(hole, now - 2000);
    await complete();
    await count(2);
    const two = await run('coverage-two');
    expect(await two({op:'mark_processed',served_id:servedId})).toMatchObject({ok:false});
    await serve('coverage-two',[hole,tied]);
    expect(await two({op:'mark_processed',prompt_id:hole})).toEqual({prompt_id:hole,marked:true});
    expect(await target.sql(`SELECT served_id FROM extraction_acks WHERE project_id=${lit(project)} AND record_id=${lit(hole)}`)).toEqual([{served_id:'coverage-two:'+hole}]);
    expect(await two({op:'mark_processed',served_id:'coverage-two:'+tied})).toMatchObject({marked:true});
    await count(0);
    expect(await target.sql('SELECT DISTINCT processed FROM prompt_batches')).toEqual([{ processed: 0 }]);
    await target.sql(`DELETE FROM agent_runs WHERE project_id=${lit(project)} AND id IN ('coverage-one','coverage-two')`);
    expect(await target.sql('SELECT COUNT(*) AS n FROM extraction_acks')).toEqual([{ n: 3 }]);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{ n: 0 }]);
    await count(0);
    const oldPrompt = crypto.randomUUID();
    await prompt(oldPrompt, now - 3000);
    await complete();
    const boundary = Number((await target.sql("SELECT value FROM schema_meta WHERE key='ledger_enabled_at'"))[0]!.value);
    const old = await run('coverage-old', boundary - 1);
    expect(await old({ op: 'mark_processed', prompt_id: oldPrompt })).toEqual({ prompt_id: oldPrompt, marked: true });
    await count(0);
  },
};
