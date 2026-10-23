import { expect } from 'bun:test';
import { expectPersisted, lit, type ParityScenario } from '../harness.ts';
import { subagentIdFor } from '@myco/member/envelope.js';

/** The same hint changes placement only when its exact session prompt becomes available. */
export const hookPlacement: ParityScenario = {
  name: 'hook placement: session and Project hints, delivery, and unplaced hook records',
  async run(target) {
    const project = lit(target.projectId);
    const session = `hook-placement-${crypto.randomUUID()}`;
    const otherSession = session + '-other';
    const otherProject = 'proj_hook_placement_other';
    const [previous, next, overlap, late, wrongSession, wrongProject] = Array.from({ length: 6 }, () => crypto.randomUUID());
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES (${lit(otherProject)},'Other',1)`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at)
      VALUES (${project},${lit(session)},'t',1,1),(${project},${lit(otherSession)},'t',1,1),(${lit(otherProject)},${lit(session)},'t',1,1)`);
    const prompt = async (id: string, ownSession = session, ownProject = target.projectId, thread = 'main') => target.sql(`INSERT INTO prompt_batches
      (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,thread_id)
      VALUES (${lit(ownProject)},${lit(ownSession)},${lit(id)},${lit(id)},'same text','user','same hash',100,100,'t',100,${lit(thread)})`);
    await prompt(previous); await prompt(next); await prompt(overlap, session, target.projectId, 'parallel');
    await prompt(wrongSession, otherSession); await prompt(wrongProject, session, otherProject);
    for (const [id, hint, selection] of [['late', late, 'selection-late'], ['wrong-session', wrongSession, 'selection-session'],
      ['wrong-project', wrongProject, 'selection-project'], ['null', null, 'selection-null'], ['placed', overlap, next]]) {
      await target.sql(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id,delivered_scope_reason)
        VALUES (${project},${lit(session)},${lit(id!)},${lit(selection!)},${lit(id!)},'[]',1,2,${hint === null ? 'NULL' : lit(hint!)},${hint === null ? "'absent_key'" : 'NULL'})`);
    }
    await target.sql(`INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,outcome,context_chars,parts,skipped,failures,selection,created_at)
      VALUES (${project},${lit(session)},'answer',${lit(previous)},'served',1,'[]','[]','[]','{}',1),
        (${project},${lit(session)},'empty',${lit(previous)},'empty',0,'[]','[]','[]','{}',1)`);
    await target.sql(`INSERT INTO session_injections(project_id,session_id,kind,created_at)
      VALUES (${project},${lit(session)},'cortex:agent',1),(${project},${lit(session)},'cortex:placed',1),(${project},${lit(session)},'cortex',1)`);
    await target.sql(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at)
      VALUES (${project},${lit(session)},'undelivered','lookup','undelivered','[]',1)`);
    await target.sql(`INSERT INTO attachments(project_id,session_id,attachment_id,event_id,prompt_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
      VALUES (${project},${lit(session)},'image','image',${lit(wrongProject)},'b','image/png',1,1,'t',1)`);
    for (const [id, kind, payload] of [['turn', 'turn', { promptId: wrongSession, phase: 'end' }],
      ['subagent.start', 'subagent.start', { subagentId: subagentIdFor(session, 'agent'), parentPromptId: wrongProject }],
      ['placed-start', 'subagent.start', { subagentId: subagentIdFor(session, 'placed'), parentPromptId: overlap }], ['subagent.stop', 'subagent.stop', {}]] as const) {
      await target.sql(`INSERT INTO events(project_id,session_id,event_id,kind,payload,token_id,channel,envelope_hash,created_at,received_at)
        VALUES (${project},${lit(session)},${lit(id)},${lit(kind)},${lit(JSON.stringify(payload))},'t','cli','h',1,1)`);
    }
    const base = `/api/projects/${target.projectId}/sessions/${session}`;
    const read = async <T,>(path: string): Promise<T> => {
      const response = await fetch(target.url + path, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return response.json() as Promise<T>;
    };
    type Row = { key: string; id: string; promptHint: string | null };
    const records = await read<{ rows: Row[] }>(base + '/unplaced');
    expect(records.rows.map(r => r.id).sort()).toEqual(['late', 'wrong-session', 'wrong-project', 'null', 'cortex:agent', 'image', 'turn', 'subagent.start', 'subagent.stop'].sort());
    const turn = (id: string) => read<{ injection: unknown; answers: { id: string }[] }>(base + '/turns/' + id);
    expect((await turn(previous)).answers.map(a => a.id).sort()).toEqual(['answer', 'empty']);
    expect((await turn(next)).injection).toBeNull();
    expect((await turn(overlap)).answers).toEqual([]);
    expect((await turn(overlap)).injection).not.toBeNull();
    await prompt(late);
    expect((await read<{ rows: Row[] }>(base + '/unplaced')).rows).toHaveLength(8);
    expect((await turn(late)).injection).not.toBeNull();
    const first = await read<{ rows: Row[]; cursor: string }>(base + '/unplaced?limit=3');
    const second = await read<{ rows: Row[] }>(base + '/unplaced?limit=3&cursor=' + encodeURIComponent(first.cursor));
    expect(new Set([...first.rows, ...second.rows].map(r => r.key)).size).toBe(6);

    for (const id of ['A', 'B', 'a', '\uE000', '\u{10000}']) {
      await target.sql(`INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,tool_name,success,created_at,token_id,received_at)
        VALUES (${project},${lit(session)},${lit(id)},${lit(id)},'Read',1,1,'t',1)`);
    }
    const full = await read<{ rows: Row[] }>(base + '/unplaced');
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const result: { rows: Row[]; cursor: string | null } = await read(base + '/unplaced?limit=1' + (cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)));
      paged.push(...result.rows.map(row => row.key));
      cursor = result.cursor;
    } while (cursor !== null);
    expect(paged).toEqual(full.rows.map(row => row.key));

    for (const adapter of ['codex', 'cursor']) {
      const hookSession = session + '-' + adapter;
      const post = async (kind: string, payload: Record<string, unknown>) => {
        const response = await fetch(target.url + '/events', { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
          body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: hookSession, kind, payload, createdAt: 1,
            channel: 'cli', producer: { adapter, version: '1' } }) });
        await expectPersisted(response, adapter + ' ' + kind);
      };
      await post('session.start', { agent: adapter, startedAt: 1 });
      const toolId = crypto.randomUUID();
      await post('tool.use', { toolCallId: toolId, toolName: 'Shell', input: { command: 'true' }, success: true });
      expect((await read<{ rows: Row[] }>(`/api/projects/${target.projectId}/sessions/${hookSession}/unplaced`)).rows.map(r => r.id)).toContain(toolId);
    }
    for (const adapter of ['claude-code', 'codex']) {
      const capturedSession = session + '-subagents-' + adapter;
      const response = await fetch(target.url + '/events', { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: capturedSession, kind: 'session.start', payload: { agent: adapter, startedAt: 1 },
          createdAt: 1, channel: 'cli', producer: { adapter, version: '1' } }) });
      await expectPersisted(response, adapter + ' session.start');
      await target.sql(`INSERT INTO session_injections(project_id,session_id,kind,created_at)
        VALUES (${project},${lit(capturedSession)},'cortex:reviewer',1)`);
      const path = `/api/projects/${target.projectId}/sessions/${capturedSession}`;
      expect((await read<{ turnContexts: Record<string, unknown> }>(path)).turnContexts).toEqual({});
      expect((await read<{ rows: Row[] }>(path + '/unplaced')).rows.map(row => row.id)).toEqual(['cortex:reviewer']);
    }
  },
};
