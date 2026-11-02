import type { RelationalStore } from './adapters.js';

export interface ExpiredPromptAnswer {
  project_id: string;
  session_id: string;
  id: string;
}

const current = `SELECT a.project_id,a.session_id,a.id
    FROM json_each(?) j CROSS JOIN prompt_context_answers a
    WHERE a.project_id=json_extract(j.value,'$.project_id')
      AND a.session_id=json_extract(j.value,'$.session_id')
      AND a.id=json_extract(j.value,'$.id') AND a.created_at<?`;

const PROMPT_ANSWER_DELETE_SQL = `DELETE FROM prompt_context_answers
  WHERE (project_id,session_id,id) IN (${current})`;

/** Deletes the named answers that still precede the retention cutoff. */
export async function pruneSelectedPromptAnswers(
  db: RelationalStore,
  targets: readonly ExpiredPromptAnswer[],
  cutoff: number,
): Promise<number> {
  const results = await db.batch(promptAnswerRetentionStatements(db, targets, cutoff));
  return results[0]!.meta.changes;
}

export function promptAnswerRetentionStatements(
  db: RelationalStore,
  targets: readonly ExpiredPromptAnswer[],
  cutoff: number,
) {
  const parameters = [JSON.stringify(targets), cutoff];
  return [
    db.prepare(PROMPT_ANSWER_DELETE_SQL).bind(...parameters),
  ];
}
