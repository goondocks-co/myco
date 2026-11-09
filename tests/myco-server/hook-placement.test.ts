import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import {
  hook_placement_listUnplacedHookRecords as listUnplacedHookRecords,
} from '@myco-server-worker/read/catalog/hook-placement.js';

import {
  turns_sessionTurnContexts as sessionTurnContexts,
} from '@myco-server-worker/read/catalog/turns.js';

const scope = { projectId: 'proj_1' };
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const env of opened.splice(0)) env.sqlite.close(); });

function fixture() {
  const env = sqliteEnv();
  opened.push(env);
  const { sqlite } = env;
  sqlite.run(`INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at)
    VALUES ('proj_1','s','t',1,1),('proj_1','other','t',1,1),('proj_2','s','t',1,1)`);
  const prompt = (id: string, session = 's', project = 'proj_1', thread = 'main') => sqlite.run(`INSERT INTO session_prompts
    (project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at,preview,thread_label)
    VALUES (?,?,1,?,?,100,'user',100,'same text',?)`, [project, session, id, id, thread]);
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

  it('pages same-time records in SQLite byte order, including mixed case and Unicode', async () => {
    const f = fixture();
    const ids = ['A', 'B', 'a', '_', '-', '\uE000', '\u{10000}'];
    for (const id of ids) f.sqlite.run(`INSERT INTO attachments(project_id,session_id,attachment_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
      VALUES ('proj_1','s',?,?,'b','image/png',1,1,'t',1)`, [id, id]);
    const expected = f.sqlite.query('SELECT attachment_id AS id FROM attachments ORDER BY attachment_id').all() as { id: string }[];
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await listUnplacedHookRecords(f.db, scope, 's', { limit: 1, cursor });
      found.push(...result.rows.map(row => row.id));
      cursor = result.cursor ?? undefined;
    } while (cursor !== undefined);
    expect(found).toEqual(expected.map(row => row.id));
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
  });

  it('lists session context and delivered plan reminders', async () => {
    const f = fixture();
    const now = 10 * 24 * 60 * 60 * 1000;
    f.sqlite.run(`INSERT INTO session_injections(project_id,session_id,kind,created_at,delivered_at)
      VALUES ('proj_1','s','cortex:agent',?,NULL),('proj_1','s','plan-nudge',?,?)`, [now, now, now]);
    f.receipt('recent', null);
    f.sqlite.run("UPDATE spore_injections SET created_at = ? WHERE id = 'recent'", [now]);
    expect((await listUnplacedHookRecords(f.db, scope, 's')).rows.map(row => row.id).sort()).toEqual(['cortex:agent', 'plan-nudge', 'recent']);
  });

  it('keeps a record that names no prompt apart from one naming a prompt the session does not hold, and places it when the prompt arrives', async () => {
    const f = fixture();
    f.sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES ('proj_1','s','live',1,1)`);
    f.receipt('no-hint', null);
    f.receipt('late-prompt', 'arrives-later');
    const placements = async () => Object.fromEntries((await listUnplacedHookRecords(f.db, scope, 's')).rows.map(row => [row.id, row.placement]));
    expect(await placements()).toEqual({ 'no-hint': 'unnamed', 'late-prompt': 'unavailable' });
    f.prompt('arrives-later');
    expect(await placements()).toEqual({ 'no-hint': 'unnamed' });
  });
});
