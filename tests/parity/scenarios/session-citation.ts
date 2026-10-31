import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** Body serving, session citation authority and old dispatches through each front door. */
export const sessionCitation: ParityScenario = {
  name: 'session citation: served ledger admits extraction writes and preserves old dispatches',
  dedicated: { cloudflare: {}, timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const now = Date.now();
    const project = target.projectId;
    const session = 'citation-session';
    const run = 'citation-run';
    const tokenId = 'mt_citation_run';
    const token = 'citation-run-synthetic-token'.padEnd(43, 'x');
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: memberHeadersFor(token, project, { 'content-type': 'application/json' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project, ...args } } }),
      });
      const body = await res.json() as { result?: { structuredContent: { result: any } }; error?: { data: { code: string } } };
      return { result: body.result?.structuredContent.result, error: body.error, body };
    };
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES('mem_harness','harness',${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','myco-agent','built-in',1,${now})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES(${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at)
      VALUES(${lit(project)},${lit(session)},'machine',${lit(tokenId)},${now - 10_000},${now},${now - 10_000},${now})`);
    const prompts = Array.from({ length: 50 }, (_, i) => ({ id: `citation-prompt-${String(i).padStart(2, '0')}`, at: now - 5_000 + i }));
    await target.sql(`INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at)
      SELECT ${lit(project)},${lit(session)},json_extract(value,'$.id'),json_extract(value,'$.id'),'Whole-session material','user','content',
        json_extract(value,'$.at'),json_extract(value,'$.at'),${lit(tokenId)},json_extract(value,'$.at') FROM json_each(${lit(JSON.stringify(prompts))})`);
    // The same prompts as the session's live document holds them.
    await target.sql(`INSERT OR IGNORE INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(${lit(project)},${lit(session)},'live',1,${now})`);
    await target.sql(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
      SELECT ${lit(project)},${lit(session)},1,json_extract(value,'$.id'),json_extract(value,'$.id'),key,'user',json_extract(value,'$.at')
      FROM json_each(${lit(JSON.stringify(prompts))})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
      VALUES(${lit(project)},${lit(run)},'myco-agent','extract-curate','running',${now},${lit(tokenId)},${lit(JSON.stringify({ session_id: session, timeoutSeconds: 300 }))})`);
    const save = { op: 'save', type: 'gotcha', content: 'A whole-session finding', session_id: session };
    expect((await call('myco_spores', save)).result).toEqual({ ok: false, error: 'session_id not served to this run' });
    expect((await call('myco_run_prompts',{op:'unprocessed'})).error?.data.code).toBe('unknown_tool');
    expect(await target.sql('SELECT * FROM run_served_material')).toEqual([]);
    await target.sql(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at)
      SELECT ${lit(project)},'citation-served-'||json_extract(value,'$.id'),${lit(run)},${lit(session)},json_extract(value,'$.id'),${now}
      FROM json_each(${lit(JSON.stringify(prompts))})`);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM run_served_material WHERE project_id=${lit(project)} AND run_id=${lit(run)}`)).toEqual([{n:50}]);
    const saved = (await call('myco_spores', save)).result;
    expect(saved.id).toEqual(expect.any(String));
    const read = (await call('myco_run_spores', { op: 'get', id: saved.id })).result;
    expect(read.spore.session_id).toBe(session);
    expect(read.spore).not.toHaveProperty('prompt_id');
    const consolidation = {
      op: 'consolidate', source_spore_ids: [saved.id], consolidated_content: 'Session wisdom', observation_type: 'wisdom', session_id: session,
    };
    expect((await call('myco_spores', consolidation)).result)
      .toEqual({ ok: false, error: 'revision is required for every source_spore_ids item' });
    const consolidated = (await call('myco_spores', {
      ...consolidation, source_spore_ids: [{ id: saved.id, revision: read.spore.revision }],
    })).result;
    expect(consolidated.new_spore_id).toEqual(expect.any(String));
    expect(await target.sql('SELECT DISTINCT session_id,prompt_id FROM spores')).toEqual([{ session_id: session, prompt_id: null }]);

    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at)
      VALUES(${lit(project)},'second-session','machine',${lit(tokenId)},${now - 10_000},${now},${now - 10_000},${now}),
        (${lit(project)},'unserved-session','machine',${lit(tokenId)},1,1,1,1)`);
    await target.sql(`UPDATE prompt_batches SET processed=1 WHERE project_id=${lit(project)} AND session_id=${lit(session)}`);
    await target.sql(`INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at)
      VALUES(${lit(project)},'second-session','second-prompt','second-event','Second session material','user','second',${now},${now},${lit(tokenId)},${now})`);
    await target.sql(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at) VALUES(${lit(project)},'citation-second',${lit(run)},'second-session','second-prompt',${now})`);
    const second = (await call('myco_spores', { ...save, session_id: 'second-session' })).result;
    expect(second.id).toEqual(expect.any(String));
    const secondRead = (await call('myco_run_spores', { op: 'get', id: second.id })).result;
    expect((await call('myco_spores', {
      op: 'consolidate', source_spore_ids: [{ id: second.id, revision: secondRead.spore.revision }], consolidated_content: 'Second session wisdom',
      observation_type: 'wisdom', session_id: 'second-session',
    })).result.new_spore_id).toEqual(expect.any(String));
    expect((await call('myco_spores', { ...save, session_id: 'unserved-session' })).result)
      .toEqual({ ok: false, error: 'session_id not served to this run' });

    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES('citation-foreign','Foreign citation',1)`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('citation-foreign','unserved-session','machine',${lit(tokenId)},1,1)`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,status,started_at)
      VALUES('citation-foreign',${lit(run)},'myco-agent','completed',1)`);
    await target.sql(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at)
      VALUES('citation-foreign','foreign-served',${lit(run)},'unserved-session','foreign-prompt',1)`);
    expect((await call('myco_spores', { ...save, session_id: 'unserved-session' })).result)
      .toEqual({ ok: false, error: 'session_id not served to this run' });

    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES(${lit(project)},'other-session','machine',${lit(tokenId)},1,1)`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,status,started_at) VALUES(${lit(project)},'other-run','myco-agent','completed',1)`);
    await target.sql(`INSERT INTO run_served_material(project_id,served_id,run_id,session_id,record_id,served_at)
      VALUES(${lit(project)},'other-served','other-run','other-session','other-prompt',1)`);
    expect((await call('myco_spores', { ...save, session_id: 'other-session' })).result)
      .toEqual({ ok: false, error: 'session_id not served to this run' });
    expect((await call('myco_spores', { ...save, project: 'another-project' })).error?.data.code).toBe('unknown_tool');

    const boundary = Number((await target.sql("SELECT value FROM schema_meta WHERE key='ledger_enabled_at'"))[0]!.value);
    await target.sql(`UPDATE agent_runs SET started_at=${boundary} WHERE project_id=${lit(project)} AND id=${lit(run)}`);
    expect((await call('myco_spores', { ...save, session_id: undefined, prompt_id: prompts[0]!.id })).result)
      .toEqual({ ok: false, error: 'session_id is required for extraction spore writes' });
    await target.sql(`UPDATE agent_runs SET started_at=${boundary - 1} WHERE project_id=${lit(project)} AND id=${lit(run)}`);
    const old = (await call('myco_spores', { ...save, session_id: undefined, prompt_id: prompts[0]!.id })).result;
    expect(old.id).toEqual(expect.any(String));
    expect(await target.sql(`SELECT session_id,prompt_id FROM spores WHERE id=${lit(String(old.id))}`)).toEqual([{ session_id: session, prompt_id: null }]);
    await target.sql(`UPDATE agent_runs SET queued_at=${boundary - 1}, started_at=${now} WHERE project_id=${lit(project)} AND id=${lit(run)}`);
    const claimedAfter = (await call('myco_spores', save)).result;
    expect(claimedAfter.id).toEqual(expect.any(String));
    const claimedRead = (await call('myco_run_spores', { op: 'get', id: claimedAfter.id })).result;
    expect((await call('myco_spores', {
      op: 'consolidate', source_spore_ids: [{ id: claimedAfter.id, revision: claimedRead.spore.revision }], consolidated_content: 'Claimed session wisdom',
      observation_type: 'wisdom', session_id: session,
    })).result.new_spore_id).toEqual(expect.any(String));
    await target.sql(`UPDATE agent_runs SET queued_at=NULL WHERE project_id=${lit(project)} AND id=${lit(run)}`);
    await target.sql(`INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by)
      VALUES(${lit(project)},${lit(session)},'deleted',${now},'parity')`);
    expect((await call('myco_spores', save)).result).toEqual({ ok: false, error: 'session_id not served to this run' });
  },
};
