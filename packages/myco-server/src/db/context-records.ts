import type { RelationalStore } from '../core/adapters.js';
import type { ContextWrite } from '../core/context-writes.js';
import { NOT_TOMBSTONED_PARAMS } from './session-read-model.js';
import { write } from './index.js';
import { prepareBound } from './kernel/statement.js';

const CONTEXT_ADMISSION_SQL = `(${NOT_TOMBSTONED_PARAMS}) AND (NOT EXISTS (SELECT 1 FROM sessions WHERE project_id = ? AND session_id = ? AND machine_id IS NOT ?))`;
export interface ContextAdmission {
  params: [string, string, string, string, string | null];
}
export const contextAdmission = (project: string, session: string, machine: string | null): ContextAdmission => ({
  params: [project, session, project, session, machine],
});
const integerFields = (values: readonly (number | null)[]) => {
  if (values.some(value => value !== null && !Number.isSafeInteger(value))) throw new Error('material_integer_invalid');
};

const injectionReceipt = write<[string, string, string, string | null, string | null, string, number | null, string, string, string, number, ...ContextAdmission['params'], string, string, string, string | null], { id: string }>({
  name: 'context.injectionReceipt', sql: `INSERT OR IGNORE INTO spore_injections (project_id,session_id,id,prompt_id,scope_reason,ask_protocol,asked_at,prompt_hash,spore_ids,plan_ids,created_at)
    SELECT ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, ?, CAST(? AS INTEGER) WHERE (${CONTEXT_ADMISSION_SQL}) AND NOT EXISTS(SELECT 1 FROM spore_injections WHERE project_id=? AND session_id=? AND (prompt_hash=? OR prompt_id=?)) RETURNING id`,
});
const promptAnswer = write<[string, string, string, string | null, string | null, string, number | null, string | null, string, number, string, string, string, string, number, ...ContextAdmission['params']], { id: string }>({
  name: 'context.promptAnswer', sql: `INSERT INTO prompt_context_answers (project_id,session_id,id,prompt_id,scope_reason,ask_protocol,asked_at,receipt_id,outcome,context_chars,parts,skipped,failures,selection,created_at)
    SELECT ?, ?, ?, ?, ?, ?, CAST(? AS INTEGER), ?, ?, CAST(? AS INTEGER), ?, ?, ?, ?, CAST(? AS INTEGER) WHERE ${CONTEXT_ADMISSION_SQL} RETURNING id`,
});
const sessionRecord = write<[string, string, string, number, ...ContextAdmission['params']], { kind: string }>({
  name: 'context.sessionRecord', sql: `INSERT OR IGNORE INTO session_injections (project_id,session_id,kind,created_at)
    SELECT ?, ?, ?, CAST(? AS INTEGER) WHERE ${CONTEXT_ADMISSION_SQL} RETURNING kind`,
});

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
  admission: ContextAdmission,
) {
  integerFields([input.askedAt, input.now]);
  return { statements: [prepareBound(db, injectionReceipt.bind(input.project, input.session, input.id, input.promptId, input.scopeReason, input.protocol, input.askedAt, input.promptHash, JSON.stringify(input.spores), JSON.stringify(input.plans), input.now, ...admission.params, input.project, input.session, input.promptHash, input.promptId))] } satisfies ContextWrite;
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
  admission: ContextAdmission,
) {
  integerFields([input.askedAt, input.chars, input.now]);
  return { statements: [prepareBound(db, promptAnswer.bind(input.project, input.session, input.id, input.promptId, input.scopeReason, input.protocol, input.askedAt, input.receiptId, input.outcome, input.chars, JSON.stringify(input.parts), JSON.stringify(input.skipped), JSON.stringify(input.failures), JSON.stringify(input.selection), input.now, ...admission.params))] } satisfies ContextWrite;
}

/** A session record is unique within its Project and session, independent of prompt capture. */
export function prepareSessionRecord(
  db: RelationalStore,
  project: string,
  session: string,
  kind: string,
  now: number,
  admission: ContextAdmission,
) {
  integerFields([now]);
  return { statements: [prepareBound(db, sessionRecord.bind(project, session, kind, now, ...admission.params))] } satisfies ContextWrite;
}

