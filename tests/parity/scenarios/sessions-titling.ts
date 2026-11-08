import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { memberHeadersFor, documentsPublished, expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';
import { SESSION_END_SETTLE_MS } from '@myco-server-worker/constants.js';

/** Capture, queue admission, owner preview and title writes share the same contract on both stores. */
export const sessionsTitling: ParityScenario = {
  name: 'sessions and titling: capture, the unbound-runtime fallback, label, MCP, an owner\'s ask',
  async run(target: ParityTarget) {
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const runSession = async (sessionId: string, prompt: string) => {
      await post(sessionId, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
      await post(sessionId, 'prompt', { promptId: crypto.randomUUID(), text: prompt, origin: 'user' });
      await post(sessionId, 'session.end', { endedAt: Date.now() });
    };
    const settleAndWake = async (id: string) => {
      await target.sql(`UPDATE sessions SET last_received_at = last_received_at - ${2 * SESSION_END_SETTLE_MS} WHERE session_id = ${lit(id)}`);
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
    };
    const sessionRow = (id: string) => target.sql(`SELECT title, summary, titled_at FROM sessions WHERE session_id=${lit(id)}`).then((rows) => rows[0]);
    const ownerRows = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: Array<{ sessionId: string; label: string }> }).rows;
    };
    const askTitle = async (id: string) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${id}/title`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { outcome: string; runId?: string };
    };

    // capture, then the end's request, taken by a wake once the session has
    // settled: titling runs on a worker, so the claim is stamped and the run
    // waits in the claim queue on both targets
    const s1 = `parity-${Date.now()}-1`;
    await runSession(s1, 'Add a retry to the runner please');
    await settleAndWake(s1);
    const runFor = (sessionId: string) => target.sql(`SELECT status, harness, held_by AS heldBy, dispatched_by IS NOT NULL AS credentialed FROM agent_runs WHERE task = 'title-summary' AND run_context LIKE ${lit(`%${sessionId}%`)} ORDER BY queued_at DESC LIMIT 1`);
    expect(await runFor(s1)).toEqual([{ status: 'queued', harness: null, heldBy: 'worker', credentialed: 0 }]);
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: expect.any(Number) });
    // The owner's ask lands inside the deferred attempt's window; it is answered as already asked.
    expect(await askTitle(s1)).toEqual({ outcome: 'already' });

    // the owner list labels the session from its first prompt while no title is written
    expect((await ownerRows()).find((row) => row.sessionId === s1)?.label).toBe('Add a retry to the runner please');

    // MCP serves the session with no title
    const mcp = await fetch(`${target.url}/mcp`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_sessions', arguments: { op: 'get', id: s1 } } }),
    });
    expect(mcp.status).toBe(200);
    const mcpRow = ((await mcp.json()) as { result: { structuredContent: { result: { id: string; title: string | null } } } }).result.structuredContent.result;
    expect([mcpRow.id, mcpRow.title]).toEqual([s1, null]);

    // a second end of the session changes nothing: one attempt per session
    const stamped = (await sessionRow(s1)) as { titled_at: number };
    await post(s1, 'session.end', { endedAt: Date.now() });
    await settleAndWake(s1);
    expect(await askTitle(s1)).toEqual({ outcome: 'already' });
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: stamped.titled_at });
    expect(await target.sql(`SELECT COUNT(*) AS c FROM agent_runs WHERE task = 'title-summary' AND run_context LIKE ${lit(`%${s1}%`)}`)).toEqual([{ c: 1 }]);

    // an open session is dispatched on an owner's ask
    const s2 = `parity-${Date.now()}-2`;
    await post(s2, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
    await post(s2, 'prompt', { promptId: crypto.randomUUID(), text: 'Rename the project from the card', origin: 'user' });
    // An ask is admitted once the publisher has caught up with the session's capture.
    await documentsPublished(target, s2);
    expect(await askTitle(s2)).toMatchObject({ outcome: 'queued' });
    expect(await runFor(s2)).toEqual([{ status: 'queued', harness: null, heldBy: 'worker', credentialed: 0 }]);
    expect(await sessionRow(s2)).toEqual({ title: null, summary: null, titled_at: expect.any(Number) });
    expect((await ownerRows()).find((row) => row.sessionId === s2)?.label).toBe('Rename the project from the card');

    const at = Date.now(), token = ('title-parity-' + crypto.randomUUID().replaceAll('-', '')).slice(0, 43);
    const tokenId = 'mt_title_attribution', runId = 'run_title_attribution';
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES('mem_harness','harness',${at})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES(${lit(tokenId)},'mem_harness','harness',${lit(await sha256Hex(token))},${at},${at + 600000},${lit(tokenId)},${at})`);
    await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
      VALUES(${lit(target.projectId)},${lit(runId)},'myco-agent','title-summary','running',${at},${lit(tokenId)},
      ${lit(JSON.stringify({session_id:s1,mode:'claim',timeoutSeconds:300}))})`);
    const writeTitle = async () => {
      const response = await fetch(`${target.url}/mcp`, {method:'POST',
        headers:memberHeadersFor(token,target.projectId,{'content-type':'application/json'}),
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'myco_run_sessions',
          arguments:{op:'title',title:'Runner retry',summary:'Added a retry to the runner.'}}}),
      });
      expect(response.status).toBe(200);
      const answer = await response.json() as {result:{structuredContent:{result:{written:boolean}}}};
      return answer.result.structuredContent.result.written;
    };
    await target.sql(`CREATE TRIGGER refuse_title_mutation BEFORE UPDATE OF title ON sessions
      WHEN OLD.project_id=${lit(target.projectId)} AND OLD.session_id=${lit(s1)} BEGIN SELECT RAISE(IGNORE); END`);
    try {
      expect(await writeTitle()).toBe(false);
      expect(await target.sql(`SELECT title FROM sessions WHERE project_id=${lit(target.projectId)} AND session_id=${lit(s1)}`))
        .toEqual([{title:null}]);
      expect(await target.sql(`SELECT COUNT(*) AS n FROM agent_run_events WHERE project_id=${lit(target.projectId)}
        AND run_id=${lit(runId)} AND event_type='run_write'`)).toEqual([{n:0}]);
    } finally { await target.sql('DROP TRIGGER refuse_title_mutation'); }
    expect((await Promise.all([writeTitle(),writeTitle()])).sort()).toEqual([false,true]);
    expect(await target.sql(`SELECT title,summary FROM sessions WHERE project_id=${lit(target.projectId)} AND session_id=${lit(s1)}`))
      .toEqual([{title:'Runner retry',summary:'Added a retry to the runner.'}]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM agent_run_events WHERE project_id=${lit(target.projectId)}
      AND run_id=${lit(runId)} AND event_type='run_write'`)).toEqual([{n:1}]);
    await target.sql(`UPDATE agent_runs SET status='completed',completed_at=${at + 1} WHERE project_id=${lit(target.projectId)} AND id=${lit(runId)}`);
  },
};
