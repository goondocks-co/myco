import { commit, read, rows, write } from './index.js';
import type { RelationalStore } from '../core/adapters.js';

export interface ExpiredPromptAnswer {
  project_id: string;
  session_id: string;
  id: string;
}

const expired = read<[cutoff: number, limit: number], ExpiredPromptAnswer>({ name: 'promptAnswer.expired', sql: `SELECT a.project_id,a.session_id,a.id
  FROM projects p CROSS JOIN prompt_context_answers a
  WHERE a.project_id=p.project_id AND a.created_at<?1 LIMIT ?2` });

/** At most `limit` answers across the Deployment's Projects created before `cutoff`. */
export const expiredPromptAnswers = (db: RelationalStore, cutoff: number, limit: number): Promise<ExpiredPromptAnswer[]> =>
  rows(db, expired.bind(cutoff, limit));

const current = `SELECT a.project_id,a.session_id,a.id
    FROM json_each(?) j CROSS JOIN prompt_context_answers a
    WHERE a.project_id=json_extract(j.value,'$.project_id')
      AND a.session_id=json_extract(j.value,'$.session_id')
      AND a.id=json_extract(j.value,'$.id') AND a.created_at<?`;

const remove = write<[string, number], { id: string }>({ name: 'promptAnswer.prune', sql: `DELETE FROM prompt_context_answers
  WHERE (project_id,session_id,id) IN (${current}) RETURNING id` });

/** Deletes the named answers that still precede the retention cutoff. */
export async function pruneSelectedPromptAnswers(
  db: RelationalStore,
  targets: readonly ExpiredPromptAnswer[],
  cutoff: number,
): Promise<number> {
  const results = await commit(db, remove.bind(JSON.stringify(targets), cutoff));
  return results[0]!.results.length;
}
