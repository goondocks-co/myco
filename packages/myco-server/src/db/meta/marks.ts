import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

const revisions = read<[], { kind: string; revision: number }>({ name: 'meta.changeMarks', sql: 'SELECT kind,revision FROM change_marks' });
const capture = read<[], { at: number | null }>({ name: 'meta.captureMark', sql: 'SELECT MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_machine_live WHERE last_live_received_at IS NOT NULL' });
export async function todayMarks(db: RelationalStore): Promise<string[]> {
  const [marks, sessions] = await readSet(db, revisions.bind(), capture.bind());
  const byKind = new Map(marks.map(row => [row.kind, String(row.revision)]));
  return [byKind.get('runs')!, String(sessions[0]?.at ?? ''), byKind.get('curation')!, byKind.get('plans')!, byKind.get('attention') ?? '', byKind.get('learning') ?? ''];
}
