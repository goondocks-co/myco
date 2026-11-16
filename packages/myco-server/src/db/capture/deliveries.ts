/** A stored render marks its context records delivered once, under the prompt or native request it names. */
import { hookScheme, type PromptIdScheme, type PromptScopeReason } from '@goondocks/myco-shared/prompt-identity';
import { schemeSharedSql } from '../documents/pins.js';
import { write, type Bound } from '../index.js';
import type { DeliveryTable } from './tool-delivery-links.js';
import { storedByThisRequest } from './event-write.js';

type Params = [at: number, project: string, session: string, scoped: number, prompt: string | null, reason: PromptScopeReason | null,
  hook: PromptIdScheme | null, id: string, answer: string | null, event: string, nonce: string];
type Target = { table: DeliveryTable; keyColumn: 'id' | 'kind'; throughAnswer: boolean };

function delivery(name: string, target: Target) {
  const shared = schemeSharedSql('?2', '?3', '?7');
  const nudge = target.throughAnswer ? ` AND EXISTS(SELECT 1 FROM prompt_context_answers a,json_each(a.parts)
    WHERE a.project_id=?2 AND a.session_id=?3 AND a.id=?9 AND json_extract(json_each.value,'$.kind')='plan-nudge')` : '';
  const predicate = `project_id=?2 AND session_id=?3 AND ${target.keyColumn}=?8 AND (delivered_at IS NULL${nudge})
    ${target.table === 'spore_injections' ? 'AND discarded_at IS NULL' : ''}
    AND ${storedByThisRequest('?2', '?10', '?11')}`;
  const statement = write<Params>({ name, sql: `UPDATE ${target.table} SET delivered_at=?1,
    delivered_prompt_id=CASE WHEN ?4=0 THEN ?5 WHEN ${shared} THEN ?5 END,
    delivered_scope_reason=CASE WHEN ?4=0 THEN ?6 WHEN ${shared} THEN NULL ELSE 'scheme' END
    WHERE ${predicate}` });
  const anchor = write<[...Params, tool: string]>({ name: `${name}.anchor`, sql: `INSERT INTO context_delivery_anchors(project_id,session_id,kind,record_id,tool_call_id)
    SELECT ?2,?3,'${target.table}',?8,?12 FROM ${target.table} WHERE ${predicate}
    ON CONFLICT DO NOTHING` });
  return { statement, anchor };
}

const INJECTION = delivery('capture.deliverInjection', { table: 'spore_injections', keyColumn: 'id', throughAnswer: false });
const ANSWER = delivery('capture.deliverAnswer', { table: 'prompt_context_answers', keyColumn: 'id', throughAnswer: false });
const SESSION_RECORD = delivery('capture.deliverSessionRecord', { table: 'session_injections', keyColumn: 'kind', throughAnswer: false });
const SESSION_RECORD_THROUGH_ANSWER = delivery('capture.deliverSessionRecordThroughAnswer', { table: 'session_injections', keyColumn: 'kind', throughAnswer: true });

export interface Delivered {
  projectId: string; sessionId: string; at: number; promptId: string | null; scopeReason: PromptScopeReason | null; scheme: PromptIdScheme | null;
  eventId: string; nonce: string; toolCallId: string | null;
}

function bind(target: ReturnType<typeof delivery>, d: Delivered, id: string, answer: string | null): Bound[] {
  const scoped = d.promptId !== null && d.scheme !== null;
  const values: Params = [d.at, d.projectId, d.sessionId, scoped ? 1 : 0, d.promptId, d.scopeReason,
    scoped ? hookScheme(d.scheme!) : null, id, answer, d.eventId, d.nonce];
  return [
    ...(d.toolCallId !== null && d.promptId === null && d.scopeReason === 'transcript_only' ? [target.anchor.bind(...values, d.toolCallId)] : []),
    target.statement.bind(...values),
  ];
}

/** Marks an injection receipt delivered, retaining its unresolved native anchor under the same admission. */
export const deliverInjection = (d: Delivered, id: string): Bound[] => bind(INJECTION, d, id, null);
/** Marks a context answer delivered under its own first-render admission. */
export const deliverAnswer = (d: Delivered, id: string): Bound[] => bind(ANSWER, d, id, null);
/** A session record follows its named answer only while that answer carries a plan nudge. */
export const deliverSessionRecord = (d: Delivered, kind: string, throughAnswer?: string): Bound[] =>
  throughAnswer === undefined ? bind(SESSION_RECORD, d, kind, null) : bind(SESSION_RECORD_THROUGH_ANSWER, d, kind, throughAnswer);
