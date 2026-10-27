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

const PROMPT_ANSWER_BINDING_DELETE_SQL = `DELETE FROM material_versions WHERE (project_id,session_id,kind,identity) IN (
  SELECT v.project_id,v.session_id,v.kind,v.identity FROM (${current}) a
  JOIN material_versions v ON v.project_id=a.project_id AND v.session_id=a.session_id
    AND v.kind='answer' AND v.owner='fact' AND v.record_id=a.id)`;

const PROMPT_ANSWER_DELETE_SQL = `DELETE FROM prompt_context_answers
  WHERE (project_id,session_id,id) IN (${current})`;

/** Named expired answers and their current fact bindings leave in the same transaction. */
export async function pruneSelectedPromptAnswers(
  db: RelationalStore,
  targets: readonly ExpiredPromptAnswer[],
  cutoff: number,
): Promise<number> {
  const results = await db.batch(promptAnswerRetentionStatements(db, targets, cutoff));
  return results[1]!.meta.changes;
}

export function promptAnswerRetentionStatements(
  db: RelationalStore,
  targets: readonly ExpiredPromptAnswer[],
  cutoff: number,
) {
  const parameters = [JSON.stringify(targets), cutoff];
  return [
    db.prepare(PROMPT_ANSWER_BINDING_DELETE_SQL).bind(...parameters),
    db.prepare(PROMPT_ANSWER_DELETE_SQL).bind(...parameters),
  ];
}
