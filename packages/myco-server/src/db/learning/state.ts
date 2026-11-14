import type { RelationalStore } from '../../core/adapters.js';
import { first, read } from '../index.js';

const state = read<[project: string, session: string], { agedOutAt: number | null }>({
  name: 'learningState.session', sql: 'SELECT aged_out_at AS agedOutAt FROM learning_sessions WHERE project_id=?1 AND session_id=?2',
});

/** The stored instant automatic learning closed this session, or null while it remains open. */
export async function learningAgedOutAt(db: RelationalStore, project: string, session: string): Promise<number | null> {
  return (await first(db, state.bind(project, session)))?.agedOutAt ?? null;
}
