import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

export function changeMarkTriggers(): Array<{ name: string; table: string; sql: string }> {
  const sources = [
    { table: 'agent_runs', kind: 'runs', columns: ['status', 'held_by', 'completed_at'] },
    { table: 'plans', kind: 'plans', columns: ['project_id', 'plan_key', 'session_id', 'event_id', 'machine_id', 'title', 'content', 'blob_key', 'content_hash', 'status', 'origin_path', 'created_at', 'updated_at', 'token_id', 'received_at', 'prompt_id', 'updated_by', 'source'] },
    { table: 'spore_curation_changes', kind: 'curation', columns: ['project_id', 'revision', 'dirty', 'pending_at'] },
  ];
  return sources.flatMap(({ table, kind, columns }) =>
    ['INSERT', 'DELETE', 'UPDATE'].map(action => {
      const name = `change_mark_${kind}_${action.toLowerCase()}`;
      const event = action === 'UPDATE' && table === 'agent_runs' ? 'UPDATE OF status,held_by,completed_at' : action;
      const when = action === 'UPDATE' ? ` WHEN ${columns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : '';
      return { name, table, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table}${when} BEGIN UPDATE change_marks SET revision=revision+1 WHERE kind='${kind}'; END` };
    }));
}
const revisions = read<[], { kind: string; revision: number }>({ name: 'meta.changeMarks', sql: 'SELECT kind,revision FROM change_marks' });
const capture = read<[], { at: number | null }>({ name: 'meta.captureMark', sql: 'SELECT MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_machine_live WHERE last_live_received_at IS NOT NULL' });
export async function todayMarks(db: RelationalStore): Promise<string[]> {
  const [marks, sessions] = await readSet(db, revisions.bind(), capture.bind());
  const byKind = new Map(marks.map(row => [row.kind, String(row.revision)]));
  return [byKind.get('runs')!, String(sessions[0]?.at ?? ''), byKind.get('curation')!, byKind.get('plans')!];
}
