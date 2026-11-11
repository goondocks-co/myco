/**
 * Marking a context row delivered.
 *
 * A delivery names a spore injection, a context answer or a session record, and marks it once: `delivered_at` and the
 * prompt that carried it are written only while the row has none, only while the caller's gate holds, and, for the
 * plan-nudge record reached through an answer, only while that answer still carries a plan nudge.
 */
import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { materialUpdate } from '../../ingest/material-mutation.js';
import type { Fragment } from '../../ingest/projections.js';
import { deliveredFields, type DeliveredNaming } from '../documents/pins.js';
import { write, type BindValue, type Statement } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { shapedStatements } from '../runs/statement-shapes.js';

type DeliveryKind = 'injection' | 'answer' | 'session-record';

const CONTEXT_MATERIAL_COLUMNS = {
  injection: ['id', 'prompt_id', 'scope_reason', 'ask_protocol', 'asked_at', 'prompt_hash', 'spore_ids', 'plan_ids', 'created_at', 'delivered_at', 'delivered_prompt_id', 'delivered_scope_reason'],
  answer: ['id', 'prompt_id', 'scope_reason', 'ask_protocol', 'asked_at', 'receipt_id', 'outcome', 'context_chars', 'parts', 'skipped', 'failures', 'selection', 'created_at', 'delivered_at', 'delivered_prompt_id', 'delivered_scope_reason'],
  'session-record': ['kind', 'created_at', 'delivered_at', 'delivered_prompt_id', 'delivered_scope_reason'],
} as const;

const SHAPE_NAMES: Readonly<Record<DeliveryKind, string>> = { injection: 'Injection', answer: 'Answer', 'session-record': 'SessionRecord' };
const THROUGH_ANSWER = ` AND EXISTS(SELECT 1 FROM prompt_context_answers a,json_each(a.parts)
    WHERE a.project_id=? AND a.session_id=? AND a.id=? AND json_extract(json_each.value,'$.kind')='plan-nudge')`;

const deliveries = shapedStatements<Statement<BindValue[], never, 'write'>>();

function assignmentsFor(kind: DeliveryKind, d: DeliveredNaming & { id: string }) {
  const definition = { session: d.sessionId, columns: ['project_id', 'session_id', ...CONTEXT_MATERIAL_COLUMNS[kind]], assignments: deliveredFields(d) };
  return kind === 'injection'
    ? materialUpdate({ ...definition, kind, table: 'spore_injections', keyColumn: 'id' }).update
    : kind === 'answer'
      ? materialUpdate({ ...definition, kind, table: 'prompt_context_answers', keyColumn: 'id' }).update
      : materialUpdate({ ...definition, kind, table: 'session_injections', keyColumn: 'kind' }).update;
}

/**
 * First delivery assigns the admitted naming to its row. Each shape (the row's kind, whether the naming is checked
 * against the session's scheme, whether the record is reached through an answer, and the caller's gate) is one
 * statement; a second gate under the same shape is refused at definition.
 */
export function prepareContextDelivery(
  db: RelationalStore,
  kind: DeliveryKind,
  d: DeliveredNaming & { id: string },
  gate: Fragment,
  throughAnswer?: string,
): { statement: PreparedStatement } {
  const table = kind === 'injection' ? 'spore_injections' : kind === 'answer' ? 'prompt_context_answers' : 'session_injections';
  const keyColumn = kind === 'session-record' ? 'kind' : 'id';
  const update = assignmentsFor(kind, d);
  const through = throughAnswer === undefined ? '' : THROUGH_ANSWER;
  const sql = `UPDATE ${table} SET ${update.sql} WHERE project_id=? AND session_id=? AND ${keyColumn}=? AND (delivered_at IS NULL${through}) AND (${gate.sql})`;
  const shape = `${SHAPE_NAMES[kind]}${update.params.length > 3 ? 'Scheme' : ''}${through === '' ? '' : 'ThroughAnswer'}`;
  const definition = deliveries(sql, () => write<BindValue[]>({ name: `context.deliver${shape}`, sql }));
  const params = [...update.params, d.projectId, d.sessionId, d.id, ...(throughAnswer === undefined ? [] : [d.projectId, d.sessionId, throughAnswer]), ...gate.params];
  return { statement: prepareBound(db, definition.bind(...(params as BindValue[]))) };
}
