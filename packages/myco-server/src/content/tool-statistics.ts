import { jsonPages } from '../db/json-pages.js';
import { ROLLUP_TOOLS } from './tool-rollup.js';
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import type { ToolState } from '../content/tool-rollup.js';


interface Entry { owner: string; kind: string; name: string; n: number; failed: number; at: number; text: string | null }
export interface StatisticsChange { id: string; state: ToolState; reset: boolean }

/** Writes exact keyed contributions and bounded, indexed summaries in the document's transaction. */
export function turnStatisticsStatements(db: RelationalStore, key: readonly unknown[], changes: readonly StatisticsChange[], finished: readonly string[]): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (const page of jsonPages(changes.map(change => change.id))) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO session_turn_totals(project_id,session_id,generation,owner)
      SELECT ?1,?2,?3,value FROM json_each(?4)`).bind(...key, JSON.stringify(page)));
  }
  for (const page of jsonPages(changes.filter(change => change.reset).map(change => change.id))) {
    statements.push(db.prepare(`DELETE FROM session_turn_entries WHERE project_id=?1 AND session_id=?2 AND generation=?3
      AND owner IN (SELECT value FROM json_each(?4))`).bind(...key, JSON.stringify(page)));
  }
  const entries: Entry[] = [];
  const removed: { owner: string; id: string }[] = [];
  for (const { id: owner, state } of changes) {
    for (const [kind, values] of [['tool', state.tools], ['file', state.files], ['named', state.named]] as const) {
      for (const [name, n] of values) entries.push({ owner, kind, name, n, failed: 0, at: 0, text: null });
    }
    for (const [name, n, failed] of state.myco) entries.push({ owner, kind: 'myco', name, n, failed, at: 0, text: null });
    for (const [name, at, text] of state.errors) entries.push({ owner, kind: 'error', name, n: 1, failed: 0, at, text });
    for (const [name, call] of Object.entries(state.calls)) entries.push({ owner, kind: 'call', name, n: 1, failed: 0, at: 0, text: JSON.stringify({ ...call, files: undefined, edited: call.files.map(path => call.named.indexOf(path)) }) });
    for (const id of new Set(state.removedErrors)) removed.push({ owner, id });
  }
  for (const page of jsonPages(removed)) statements.push(db.prepare(`DELETE FROM session_turn_entries WHERE project_id=?1 AND session_id=?2 AND generation=?3
    AND (owner,kind,name) IN (SELECT json_extract(value,'$.owner'),'error',json_extract(value,'$.id') FROM json_each(?4))`)
    .bind(...key, JSON.stringify(page)));
  for (const page of jsonPages(entries)) {
    const rows = JSON.stringify(page);
    statements.push(db.prepare(`INSERT INTO session_turn_entries(project_id,session_id,generation,owner,kind,name,n,failed,at,text)
      SELECT ?1,?2,?3,json_extract(value,'$.owner'),json_extract(value,'$.kind'),json_extract(value,'$.name'),
        json_extract(value,'$.n'),json_extract(value,'$.failed'),json_extract(value,'$.at'),json_extract(value,'$.text') FROM json_each(?4) WHERE true
      ON CONFLICT(project_id,session_id,generation,owner,kind,name) DO UPDATE SET
        n=CASE WHEN excluded.kind IN ('call','error') THEN excluded.n ELSE n+excluded.n END,
        failed=failed+excluded.failed,at=excluded.at,text=excluded.text`).bind(...key, rows));
    statements.push(db.prepare(`DELETE FROM session_turn_entries WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND (owner,kind,name) IN
      (SELECT json_extract(value,'$.owner'),json_extract(value,'$.kind'),json_extract(value,'$.name') FROM json_each(?4)) AND n<=0`).bind(...key, rows));
  }
  const match = `e.project_id=p.project_id AND e.session_id=p.session_id AND e.generation=p.generation AND e.owner=p.prompt_id`;
  const top = (kind: string, fields: string) => `SELECT ${fields} FROM session_turn_entries e INDEXED BY idx_session_turn_entries_count
    WHERE ${match} AND e.kind IN ('tool','myco') AND e.kind='${kind}' ORDER BY e.n DESC,e.name LIMIT ${ROLLUP_TOOLS}`;
  for (const page of jsonPages(finished)) statements.push(db.prepare(`UPDATE session_prompts AS p SET
    files_named=(SELECT named FROM session_turn_totals t WHERE t.project_id=p.project_id AND t.session_id=p.session_id AND t.generation=p.generation AND t.owner=p.prompt_id),
    tool_rollup=json_object(
      'tools',json((SELECT json_group_array(json_object('name',name,'count',n)) FROM
        (SELECT name,n FROM (${top('tool', 'name,n')}) UNION ALL
         SELECT 'other',json_extract(p.tool_state,'$.total')-COALESCE((SELECT SUM(n) FROM (${top('tool', 'n')})),0)
         WHERE json_extract(p.tool_state,'$.total')>COALESCE((SELECT SUM(n) FROM (${top('tool', 'n')})),0)))),
      'myco',json((SELECT json_group_array(json_object('name',name,'count',n,'failed',failed)) FROM (${top('myco', 'name,n,failed')}))),
      'firstError',(SELECT text FROM session_turn_entries e INDEXED BY idx_session_turn_entries_error
        WHERE ${match} AND e.kind='error' ORDER BY e.at,e.name LIMIT 1),
      'filesEdited',(SELECT files FROM session_turn_totals t WHERE t.project_id=p.project_id AND t.session_id=p.session_id AND t.generation=p.generation AND t.owner=p.prompt_id),
      'lastRecordAt',json_extract(p.tool_state,'$.last'))
    WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.prompt_id IN (SELECT value FROM json_each(?4))`).bind(...key, JSON.stringify(page)));
  return statements;
}

/** Reads only metadata for calls in the held page window or changed record set. */
export async function heldToolCalls(db: RelationalStore, key: readonly unknown[], records: readonly { owner: string; id: string }[]): Promise<ToolState['calls']> {
  const calls: ToolState['calls'] = {};
  for (const page of jsonPages(records)) {
    const rows = (await db.prepare(`SELECT e.name,e.text FROM json_each(?4) j CROSS JOIN session_turn_entries e
      ON e.project_id=?1 AND e.session_id=?2 AND e.generation=?3 AND e.owner=json_extract(j.value,'$.owner') AND e.kind='call' AND e.name=json_extract(j.value,'$.id')`)
      .bind(...key, JSON.stringify(page)).all<{ name: string; text: string }>()).results;
    for (const row of rows) Object.defineProperty(calls, row.name, { value: (() => { const call = JSON.parse(row.text) as Omit<ToolState['calls'][string], 'files'> & { edited: number[] }; return { ...call, files: call.edited.map(at => call.named[at]!) }; })(), enumerable: true, writable: true, configurable: true });
  }
  return calls;
}
