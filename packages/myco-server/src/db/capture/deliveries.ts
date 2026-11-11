/**
 * A `context.delivered` event's effect on the context rows it names: each is marked delivered at the event's own
 * instant, in its own session, once, and only when this request stored the event. The prompt that carried it is
 * recorded as named, or, when named under a scheme the session's prompts are not named by, as `scheme`.
 */
import { hookScheme, type PromptIdScheme, type PromptScopeReason } from '@goondocks/myco-shared/prompt-identity';
import { schemeSharedSql } from '../documents/pins.js';
import { write, type BindValue, type Bound } from '../index.js';
import { Slots } from './slots.js';
import { storedByThisRequest } from './event-write.js';

type Label = 'at' | 'scoped' | 'prompt' | 'reason' | 'project' | 'session' | 'hook' | 'id' | 'answer' | 'event' | 'nonce';

/** A delivered row: the record it marks, by kind, and for a session record reached through an answer, the answer that names it. */
type Target = { table: 'spore_injections' | 'prompt_context_answers' | 'session_injections'; keyColumn: 'id' | 'kind'; throughAnswer: boolean };

function delivery(name: string, target: Target) {
  const slots = new Slots<Label>();
  const [project, session] = [slots.at('project'), slots.at('session')];
  const shared = schemeSharedSql(project, session, slots.at('hook'));
  const [scoped, prompt] = [slots.at('scoped'), slots.at('prompt')];
  const nudge = target.throughAnswer ? ` AND EXISTS(SELECT 1 FROM prompt_context_answers a,json_each(a.parts)
    WHERE a.project_id=${project} AND a.session_id=${session} AND a.id=${slots.at('answer')} AND json_extract(json_each.value,'$.kind')='plan-nudge')` : '';
  const statement = write<BindValue[]>({ name, sql: `UPDATE ${target.table} SET delivered_at = ${slots.at('at')},
      delivered_prompt_id = CASE WHEN ${scoped} = 0 THEN ${prompt} WHEN ${shared} THEN ${prompt} END,
      delivered_scope_reason = CASE WHEN ${scoped} = 0 THEN ${slots.at('reason')} WHEN ${shared} THEN NULL ELSE 'scheme' END
    WHERE project_id=${project} AND session_id=${session} AND ${target.keyColumn}=${slots.at('id')} AND (delivered_at IS NULL${nudge})
      AND ${storedByThisRequest(project, slots.at('event'), slots.at('nonce'))}` });
  return { slots, statement };
}

const INJECTION = delivery('capture.deliverInjection', { table: 'spore_injections', keyColumn: 'id', throughAnswer: false });
const ANSWER = delivery('capture.deliverAnswer', { table: 'prompt_context_answers', keyColumn: 'id', throughAnswer: false });
const SESSION_RECORD = delivery('capture.deliverSessionRecord', { table: 'session_injections', keyColumn: 'kind', throughAnswer: false });
const SESSION_RECORD_THROUGH_ANSWER = delivery('capture.deliverSessionRecordThroughAnswer', { table: 'session_injections', keyColumn: 'kind', throughAnswer: true });

/** How one delivery names the prompt that carried it, and the request that stored its event. */
export interface Delivered {
  projectId: string; sessionId: string; at: number; promptId: string | null; scopeReason: PromptScopeReason | null; scheme: PromptIdScheme | null;
  eventId: string; nonce: string;
}

function bind(target: ReturnType<typeof delivery>, d: Delivered, id: string, answer: string | null): Bound {
  const scoped = d.promptId !== null && d.scheme !== null;
  return target.statement.bind(...target.slots.values({
    at: d.at, scoped: scoped ? 1 : 0, prompt: d.promptId, reason: d.scopeReason, project: d.projectId, session: d.sessionId,
    hook: scoped ? hookScheme(d.scheme!) : null, id, answer, event: d.eventId, nonce: d.nonce,
  }));
}

/** Marks an injection receipt delivered. */
export const deliverInjection = (d: Delivered, id: string): Bound => bind(INJECTION, d, id, null);
/** Marks a prompt's context answer delivered. */
export const deliverAnswer = (d: Delivered, id: string): Bound => bind(ANSWER, d, id, null);
/** Marks a session record delivered by its own key, or, when `throughAnswer` names the answer that carried it, only while that answer holds a plan nudge. */
export const deliverSessionRecord = (d: Delivered, kind: string, throughAnswer?: string): Bound =>
  throughAnswer === undefined ? bind(SESSION_RECORD, d, kind, null) : bind(SESSION_RECORD_THROUGH_ANSWER, d, kind, throughAnswer);
