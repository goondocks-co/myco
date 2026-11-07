import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

export function changeMarkTriggers(): Array<{ name: string; table: string; sql: string }> {
  return [['agent_runs', 'runs'], ['plans', 'plans'], ['spore_curation_changes', 'curation']].flatMap(([table, kind]) =>
    ['INSERT', 'DELETE', 'UPDATE'].map(action => {
      const name = `change_mark_${kind}_${action.toLowerCase()}`;
      const event = action === 'UPDATE' && table === 'agent_runs' ? 'UPDATE OF status,held_by,completed_at' : action;
      return { name, table: table!, sql: `CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${table} BEGIN UPDATE change_marks SET revision=revision+1 WHERE kind='${kind}'; END` };
    }));
}
const revisions = read<[], { kind: string; revision: number }>({ name: 'meta.changeMarks', sql: 'SELECT kind,revision FROM change_marks' });
const capture = read<[], { at: number | null }>({ name: 'meta.captureMark', sql: 'SELECT MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_machine_live WHERE last_live_received_at IS NOT NULL' });
export async function todayMarks(db: RelationalStore): Promise<string[]> {
  const [marks, sessions] = await readSet(db, revisions.bind(), capture.bind());
  const byKind = new Map(marks.map(row => [row.kind, String(row.revision)]));
  return [byKind.get('runs')!, String(sessions[0]?.at ?? ''), byKind.get('curation')!, byKind.get('plans')!];
}
