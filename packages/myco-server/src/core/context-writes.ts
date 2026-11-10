import type { PreparedStatement, RelationalStore } from './adapters.js';
import {
  materialUpdate,
} from '../ingest/material-mutation.js';
import type { Fragment } from '../ingest/projections.js';
import { deliveredFields, type DeliveredNaming } from '../ingest/prompt-scheme.js';

const CONTEXT_MATERIAL_COLUMNS = {
  injection:['id','prompt_id','scope_reason','ask_protocol','asked_at','prompt_hash','spore_ids','plan_ids','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  answer:['id','prompt_id','scope_reason','ask_protocol','asked_at','receipt_id','outcome','context_chars','parts','skipped','failures','selection','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  'session-record':['kind','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
} as const;

/** First delivery assigns the admitted naming to its row. */
export function prepareContextDelivery(
  db: RelationalStore,
  kind: 'injection' | 'answer' | 'session-record',
  d: DeliveredNaming & { id: string },
  gate: Fragment,
  throughAnswer?: string,
) {
  const table =
    kind === 'injection' ? 'spore_injections' : kind === 'answer' ? 'prompt_context_answers' : 'session_injections';
  const keyColumn = kind === 'session-record' ? 'kind' : 'id';
  const assignments = deliveredFields(d);
  const when = {
    sql: `delivered_at IS NULL${
      throughAnswer === undefined
        ? ''
        : ` AND EXISTS(SELECT 1 FROM prompt_context_answers a,json_each(a.parts)
    WHERE a.project_id=? AND a.session_id=? AND a.id=? AND json_extract(json_each.value,'$.kind')='plan-nudge')`
    }`,
    params: throughAnswer === undefined ? [] : [d.projectId, d.sessionId, throughAnswer],
  };
  const definition = {
    session: d.sessionId,
    columns: ['project_id', 'session_id', ...CONTEXT_MATERIAL_COLUMNS[kind]],
    assignments,
  };
  const update =
    kind === 'injection'
      ? materialUpdate({ ...definition, kind, table: 'spore_injections', keyColumn: 'id' })
      : kind === 'answer'
        ? materialUpdate({ ...definition, kind, table: 'prompt_context_answers', keyColumn: 'id' })
        : materialUpdate({ ...definition, kind, table: 'session_injections', keyColumn: 'kind' });
  const statement = db
    .prepare(
      `UPDATE ${table} SET ${update.update.sql} WHERE project_id=? AND session_id=? AND ${keyColumn}=? AND (${when.sql}) AND (${gate.sql})`,
    )
    .bind(...update.update.params, d.projectId, d.sessionId, d.id, ...when.params, ...gate.params);
  return { statement } satisfies { statement: PreparedStatement };
}
