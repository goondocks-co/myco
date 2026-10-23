import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { countUnplacedContextRecords, listUnplacedHookRecords } from '@myco-server-worker/read/hook-placement.js';
import { listAttachments, listToolCalls } from '@myco-server-worker/read/children.js';
import { sessionTurnContexts, turnDetail } from '@myco-server-worker/read/turns.js';
import { subagentIdFor } from '@myco/member/envelope.js';

const scope = { projectId: 'proj_1' };
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const env of opened.splice(0)) env.sqlite.close(); });

function fixture() {
  const env = sqliteEnv();
  opened.push(env);
  const { sqlite } = env;
  sqlite.run(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at)
    VALUES ('proj_1','s','t',1,1),('proj_1','other','t',1,1),('proj_2','s','t',1,1)`);
  const prompt = (id: string, session = 's', project = 'proj_1', thread = 'main') => sqlite.run(`INSERT INTO prompt_batches
    (project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at,thread_id)
    VALUES (?,?,?,?,'same text','user','same hash',100,100,'t',100,?)`, [project, session, id, id, thread]);
  prompt('previous'); prompt('next'); prompt('overlap', 's', 'proj_1', 'parallel');
  prompt('other-session', 'other'); prompt('other-project', 's', 'proj_2');
  const receipt = (id: string, hint: string | null, selected = 'selection-' + id) => sqlite.run(`INSERT INTO spore_injections
    (project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at,delivered_at,delivered_prompt_id,delivered_scope_reason)
    VALUES ('proj_1','s',?,?,?,'[]',1,2,?,?)`, [id, selected, id, hint, hint === null ? 'absent_key' : null]);
  const answer = (id: string, outcome = 'empty') => sqlite.run(`INSERT INTO prompt_context_answers
    (project_id,session_id,id,prompt_id,outcome,context_chars,parts,skipped,failures,selection,created_at)
    VALUES ('proj_1','s',?,'previous',?,0,'[]','[]','[]','{}',1)`, [id, outcome]);
  return { ...env, prompt, receipt, answer };
}

describe('hook placement', () => {
  it('requires the same session and Project, then places an early ask when its exact prompt arrives', async () => {
    const f = fixture();
    for (const hint of ['late', 'other-session', 'other-project', null]) f.receipt(String(hint), hint);
    expect(await countUnplacedContextRecords(f.db, scope, 's', 100)).toBe(4);
    expect((await listUnplacedHookRecords(f.db, scope, 's')).rows.map(r => r.promptHint).sort()).toEqual([null, 'late', 'other-project', 'other-session'].sort());
    expect((await turnDetail(f.db, scope, 's', 'previous'))?.injection).toBeNull();
    f.prompt('late');
    expect(await countUnplacedContextRecords(f.db, scope, 's', 100)).toBe(3);
    expect((await turnDetail(f.db, scope, 's', 'late'))?.injection).not.toBeNull();
    expect(await countUnplacedContextRecords(f.db, { projectId: 'proj_2' }, 's', 100)).toBe(0);
  });

  it('places delivery on a previous prompt or overlapping thread, while selection only diagnoses', async () => {
    const f = fixture();
    f.receipt('receipt', 'overlap', 'next');
    f.answer('answer', 'served');
    f.answer('empty');
    f.sqlite.run("INSERT INTO session_injections(project_id,session_id,kind,created_at) VALUES ('proj_1','s','cortex',1)");
    f.sqlite.run(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at)
      VALUES ('proj_1','s','undelivered','lookup','undelivered','[]',1)`);
    expect((await turnDetail(f.db, scope, 's', 'previous'))?.answers.map(r => r.id).sort()).toEqual(['answer', 'empty']);
    expect((await turnDetail(f.db, scope, 's', 'next'))?.injection).toBeNull();
    expect((await turnDetail(f.db, scope, 's', 'overlap'))?.answers).toEqual([]);
    expect((await turnDetail(f.db, scope, 's', 'overlap'))?.injection).not.toBeNull();
    expect((await listUnplacedHookRecords(f.db, scope, 's')).rows).toEqual([]);
    expect(await countUnplacedContextRecords(f.db, scope, 's', 100)).toBe(0);
    f.receipt('previous-delivery', 'previous', 'overlap');
    expect((await turnDetail(f.db, scope, 's', 'previous'))?.injection).not.toBeNull();
  });

  it('pages same-time records in SQLite byte order, including mixed case and Unicode', async () => {
    const f = fixture();
    const ids = ['A', 'B', 'a', '_', '-', '\uE000', '\u{10000}'];
    for (const id of ids) f.sqlite.run(`INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,tool_name,success,created_at,token_id,received_at)
      VALUES ('proj_1','s',?,?,'Read',1,1,'t',1)`, [id, id]);
    const expected = f.sqlite.query('SELECT tool_call_id AS id FROM tool_calls ORDER BY tool_call_id').all() as { id: string }[];
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listUnplacedHookRecords(f.db, scope, 's', { limit: 1, cursor });
      found.push(...result.rows.map(row => row.id));
      cursor = result.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(found).toEqual(expected.map(row => row.id));
  });

  it('counts delivered orphan answers once and keeps selection diagnostics out of the unplaced classes', async () => {
    const f = fixture();
    f.receipt('receipt', null);
    f.sqlite.run(`INSERT INTO prompt_context_answers
      (project_id,session_id,id,prompt_id,receipt_id,outcome,context_chars,parts,skipped,failures,selection,created_at,delivered_at,delivered_scope_reason)
      VALUES ('proj_1','s','linked','previous','receipt','served',1,'[]','[]','[]','{}',1,2,'absent_key'),
        ('proj_1','s','orphan','missing','gone','served',1,'[]','[]','[]','{}',1,2,'absent_key'),
        ('proj_1','s','diagnostic','previous','gone','served',1,'[]','[]','[]','{}',1,2,'absent_key')`);
    f.sqlite.run(`INSERT INTO prompt_context_answers
      (project_id,session_id,id,prompt_id,outcome,context_chars,parts,skipped,failures,selection,created_at)
      VALUES ('proj_1','s','undelivered','missing','served',1,'[]','[]','[]','{}',1)`);
    expect((await listUnplacedHookRecords(f.db, scope, 's')).rows.map(row => row.id).sort()).toEqual(['orphan', 'receipt']);
    expect(await countUnplacedContextRecords(f.db, scope, 's', 100)).toBe(2);
    expect((await turnDetail(f.db, scope, 's', 'previous'))?.answers.map(row => row.id).sort()).toEqual(['diagnostic', 'linked']);
  });

  it('shows tools, attachments, session context, sub-agent and turn records with unresolved or absent hints', async () => {
    const f = fixture();
    for (const [id, hint, tool] of [['codex', 'other-session', 'exec_command'], ['cursor', 'other-project', 'Shell'], ['placed', 'overlap', 'Read'], ['no-hint', null, 'Write']]) {
      f.sqlite.run(`INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,prompt_id,tool_name,success,created_at,token_id,received_at)
        VALUES ('proj_1','s',?,?,?, ?,1,1,'t',1)`, [id, id, hint, tool]);
    }
    f.sqlite.run(`INSERT INTO attachments(project_id,session_id,attachment_id,event_id,prompt_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
      VALUES ('proj_1','s','image','image','other-session','blob','image/png',1,1,'t',1)`);
    f.sqlite.run(`INSERT INTO session_injections(project_id,session_id,kind,created_at)
      VALUES ('proj_1','s','cortex:agent',1),('proj_1','s','cortex:placed',1),('proj_1','s','cortex:no-hint',1)`);
    for (const [id, kind, payload] of [['turn', 'turn', { promptId: 'other-session', phase: 'end' }],
      ['start', 'subagent.start', { subagentId: subagentIdFor('s', 'agent'), parentPromptId: 'other-project' }],
      ['placed-start', 'subagent.start', { subagentId: subagentIdFor('s', 'placed'), parentPromptId: 'overlap' }],
      ['no-hint-start', 'subagent.start', { subagentId: subagentIdFor('s', 'no-hint') }], ['stop', 'subagent.stop', {}]]) {
      f.sqlite.run(`INSERT INTO events(project_id,session_id,event_id,kind,payload,token_id,channel,envelope_hash,created_at,received_at)
        VALUES ('proj_1','s',?,?,?,'t','cli','h',1,1)`, [id as string, kind as string, JSON.stringify(payload)]);
    }
    const all = await listUnplacedHookRecords(f.db, scope, 's');
    expect(all.rows.map(r => r.id).sort()).toEqual(['codex', 'cursor', 'no-hint', 'image', 'cortex:agent', 'cortex:no-hint', 'turn', 'start', 'no-hint-start', 'stop'].sort());
    expect(await countUnplacedContextRecords(f.db, scope, 's', 100)).toBe(0);
    const first = await listUnplacedHookRecords(f.db, scope, 's', { limit: 3 });
    const second = await listUnplacedHookRecords(f.db, scope, 's', { limit: 3, cursor: first.cursor! });
    const third = await listUnplacedHookRecords(f.db, scope, 's', { limit: 3, cursor: second.cursor! });
    const fourth = await listUnplacedHookRecords(f.db, scope, 's', { limit: 3, cursor: third.cursor! });
    expect([...first.rows, ...second.rows, ...third.rows, ...fourth.rows].map(r => r.key)).toEqual(all.rows.map(r => r.key));
    expect((await listToolCalls(f.db, scope, 's')).rows.filter(r => r.promptId !== null).map(r => r.toolCallId)).toEqual(['placed']);
    expect((await listToolCalls(f.db, scope, 's', { promptId: 'other-session' })).rows).toEqual([]);
    expect((await listAttachments(f.db, scope, 's')).rows[0].promptId).toBeNull();
    expect(await sessionTurnContexts(f.db, scope, 's')).toEqual({ overlap: { subagents: 1 } });
  });

  it.each(['claude-code', 'codex'])('shows %s sub-agent context without a start-event hint in the session list', async agent => {
    const f = fixture();
    const session = 'captured-' + agent;
    f.sqlite.run(`INSERT INTO sessions(project_id,session_id,created_by_token_id,agent,first_received_at,last_received_at)
      VALUES ('proj_1',?,'t',?,1,100)`, [session, agent]);
    f.prompt('parent', session);
    f.sqlite.run(`INSERT INTO session_injections(project_id,session_id,kind,created_at)
      VALUES ('proj_1',?,'cortex',1),('proj_1',?,'cortex:agent-one',2),('proj_1',?,'cortex:agent-two',3)`, [session, session, session]);
    f.sqlite.run(`INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,created_at)
      VALUES ('proj_1',?,'last-lookup','parent','last','[]',3)`, [session]);
    expect(await sessionTurnContexts(f.db, scope, session)).toEqual({});
    expect((await listUnplacedHookRecords(f.db, scope, session)).rows.map(row => row.id)).toEqual(['cortex:agent-one', 'cortex:agent-two']);
    expect(await countUnplacedContextRecords(f.db, scope, session, 100)).toBe(0);
  });

  it('lists session context and delivered plan reminders while status counts only deliveries', async () => {
    const f = fixture();
    const now = 10 * 24 * 60 * 60 * 1000;
    f.sqlite.run(`INSERT INTO session_injections(project_id,session_id,kind,created_at,delivered_at)
      VALUES ('proj_1','s','cortex:agent',?,NULL),('proj_1','s','plan-nudge',?,?)`, [now, now, now]);
    f.receipt('recent', null);
    f.sqlite.run("UPDATE spore_injections SET created_at = ? WHERE id = 'recent'", [now]);
    expect((await listUnplacedHookRecords(f.db, scope, 's')).rows.map(row => row.id).sort()).toEqual(['cortex:agent', 'plan-nudge', 'recent']);
    expect(await countUnplacedContextRecords(f.db, scope, 's', now)).toBe(1);
  });
});
