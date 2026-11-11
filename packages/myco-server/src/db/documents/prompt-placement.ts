import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { placedPromptSql } from './live-generation.js';

const placed = read<[project: string, session: string, prompt: string], { present: number }>({ name: 'promptPlacement.placed', sql:
  `SELECT 1 AS present WHERE ${placedPromptSql({ project: '?1', session: '?2', prompt: '?3' })}` });

/** True when a prompt of that id sits in the session's live document. */
export async function promptPlaced(db: RelationalStore, project: string, session: string, prompt: string): Promise<boolean> {
  const [rows] = await readSet(db, placed.bind(project, session, prompt));
  return rows.length > 0;
}
