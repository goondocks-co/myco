import type { PreparedStatement, RelationalStore, RunResult } from './adapters.js';
import {
  materialFields,
  materialMerge,
  materialUpdate,
} from '../ingest/material-mutation.js';
import type { Fragment } from '../ingest/projections.js';
import { deliveredFields, type DeliveredNaming } from '../ingest/prompt-scheme.js';

export interface ContextWrite {
  statements: readonly PreparedStatement[];
}
export type ContextCommit = (db: RelationalStore, write: ContextWrite) => Promise<RunResult[]>;
export const commitContextWrite: ContextCommit = async (db, write) =>
  write.statements.length === 1 ? [await write.statements[0]!.run()] : db.batch([...write.statements]);
const CONTEXT_MATERIAL_COLUMNS = {
  injection:['id','prompt_id','scope_reason','ask_protocol','asked_at','prompt_hash','spore_ids','plan_ids','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  answer:['id','prompt_id','scope_reason','ask_protocol','asked_at','receipt_id','outcome','context_chars','parts','skipped','failures','selection','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
  'session-record':['kind','created_at','delivered_at','delivered_prompt_id','delivered_scope_reason'],
} as const;

/** Receipt uniqueness and the stored row use the same admitted identity. */
export function prepareInjectionReceipt(
  db: RelationalStore,
  input: {
    project: string;
    session: string;
    id: string;
    promptId: string | null;
    scopeReason: string | null;
    protocol: string;
    askedAt: number | null;
    promptHash: string;
    spores: readonly string[];
    plans: readonly string[];
    now: number;
  },
  admission: Fragment,
) {
  const unique = {
    sql: `NOT EXISTS(SELECT 1 FROM spore_injections WHERE project_id=? AND session_id=? AND (prompt_hash=? OR prompt_id=?))`,
    params: [input.project, input.session, input.promptHash, input.promptId],
  };
  const merge = materialMerge({
    kind: 'injection',
    table: 'spore_injections',
    keyColumn: 'id',
    sessionKey: true,
    incoming: materialFields(
      {
        project_id: input.project,
        session_id: input.session,
        id: input.id,
        prompt_id: input.promptId,
        scope_reason: input.scopeReason,
        ask_protocol: input.protocol,
        asked_at: input.askedAt,
        prompt_hash: input.promptHash,
        spore_ids: JSON.stringify(input.spores),
        plan_ids: JSON.stringify(input.plans),
        created_at: input.now,
      },
      ['asked_at', 'created_at'],
    ),
    assignments: [],
  });
  const statement = db
    .prepare(
      `INSERT OR IGNORE INTO spore_injections (${merge.insert.columns.join(',')})
    SELECT ${merge.insert.sql} WHERE (${admission.sql}) AND (${unique.sql})`,
    )
    .bind(...merge.insert.params, ...admission.params, ...unique.params);
  return {
    statements: [statement],
  } satisfies ContextWrite;
}

/** Every prompt answer retains its minted id and admitted diagnostics. */
export function preparePromptAnswer(
  db: RelationalStore,
  input: {
    project: string;
    session: string;
    id: string;
    promptId: string | null;
    scopeReason: string | null;
    protocol: string;
    askedAt: number | null;
    receiptId: string | null;
    outcome: 'served' | 'empty';
    chars: number;
    parts: unknown;
    skipped: unknown;
    failures: unknown;
    selection: unknown;
    now: number;
  },
  admission: Fragment,
) {
  const merge = materialMerge({
    kind: 'answer',
    table: 'prompt_context_answers',
    keyColumn: 'id',
    sessionKey: true,
    incoming: materialFields(
      {
        project_id: input.project,
        session_id: input.session,
        id: input.id,
        prompt_id: input.promptId,
        scope_reason: input.scopeReason,
        ask_protocol: input.protocol,
        asked_at: input.askedAt,
        receipt_id: input.receiptId,
        outcome: input.outcome,
        context_chars: input.chars,
        parts: JSON.stringify(input.parts),
        skipped: JSON.stringify(input.skipped),
        failures: JSON.stringify(input.failures),
        selection: JSON.stringify(input.selection),
        created_at: input.now,
      },
      ['asked_at', 'context_chars', 'created_at'],
    ),
    assignments: [],
  });
  const statement = db
    .prepare(
      `INSERT INTO prompt_context_answers (${merge.insert.columns.join(',')}) SELECT ${merge.insert.sql} WHERE ${admission.sql}`,
    )
    .bind(...merge.insert.params, ...admission.params);
  return {
    statements: [statement],
  } satisfies ContextWrite;
}

/** A session record is unique within its Project and session, independent of prompt capture. */
export function prepareSessionRecord(
  db: RelationalStore,
  project: string,
  session: string,
  kind: string,
  now: number,
  admission: Fragment,
) {
  const merge = materialMerge({
    kind: 'session-record',
    table: 'session_injections',
    keyColumn: 'kind',
    sessionKey: true,
    incoming: materialFields({ project_id: project, session_id: session, kind, created_at: now }, ['created_at']),
    assignments: [],
  });
  const statement = db
    .prepare(
      `INSERT OR IGNORE INTO session_injections (${merge.insert.columns.join(',')}) SELECT ${merge.insert.sql} WHERE ${admission.sql}`,
    )
    .bind(...merge.insert.params, ...admission.params);
  return {
    statements: [statement],
  } satisfies ContextWrite;
}

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
  return {
    statement,
    statements: [statement],
  } satisfies ContextWrite & { statement: PreparedStatement };
}
