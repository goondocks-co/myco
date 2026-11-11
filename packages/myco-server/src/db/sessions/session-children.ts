import type { RelationalStore } from '../../core/adapters.js';
import { placedPromptSql } from '../documents/live-generation.js';
import { readSlotted, slottedRead } from '../slotted-read.js';

export interface AttachmentChildRow {
  prompt_id: string | null; attachment_id: string; blob_key: string; media_type: string; byte_size: number; description: string | null; created_at: number; order_at: number;
}
export interface ContextInjectionChildRow { kind: string; created_at: number; delivery: 'unnamed_prompt' | 'not_delivered' | null; order_at: number }

/** The prefix of an answer row's `kind` in the session's context records. */
const SESSION_ANSWER_KIND_PREFIX = 'context:';

const placedOn = (table: string, prompt: string) => placedPromptSql({ project: `${table}.project_id`, session: `${table}.session_id`, prompt: `${table}.${prompt}` });

const KEYSET = ' AND created_at >= {at} AND (created_at > {at} OR (created_at = {at} AND {key} > {afterKey}))';

const attachment = (name: string, prompt: boolean, after: boolean) => slottedRead<AttachmentChildRow>(name,
  `SELECT CASE WHEN ${placedOn('attachments', 'prompt_id')} THEN attachments.prompt_id ELSE NULL END AS prompt_id, attachment_id, blob_key, media_type, byte_size, description, created_at, created_at AS order_at, attachment_id
    FROM attachments WHERE project_id = {project} AND session_id = {session}${prompt ? ` AND prompt_id = {prompt} AND ${placedOn('attachments', 'prompt_id')}` : ''}${after ? KEYSET.replace('{key}', 'attachment_id') : ''}
    ORDER BY created_at ASC, attachment_id ASC LIMIT {limit}`);
const attachments = { first: attachment('sessionChildren.attachmentsFirst', false, false), after: attachment('sessionChildren.attachmentsAfter', false, true),
  promptFirst: attachment('sessionChildren.promptAttachmentsFirst', true, false), promptAfter: attachment('sessionChildren.promptAttachmentsAfter', true, true) };

const INJECTIONS = `(SELECT project_id, session_id, kind, created_at, NULL AS delivery FROM session_injections
     UNION ALL
     SELECT project_id, session_id, '${SESSION_ANSWER_KIND_PREFIX}' || id AS kind, created_at,
       CASE WHEN delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM prompt_context_answers WHERE outcome = 'served' AND NOT ${placedPromptSql({ project: 'prompt_context_answers.project_id', session: 'prompt_context_answers.session_id', prompt: 'prompt_context_answers.delivered_prompt_id' })}
     UNION ALL
     SELECT r.project_id, r.session_id, '${SESSION_ANSWER_KIND_PREFIX}' || r.id AS kind, r.created_at,
       CASE WHEN r.delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM spore_injections r WHERE NOT ${placedPromptSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.delivered_prompt_id' })}
         AND NOT EXISTS (SELECT 1 FROM prompt_context_answers a
                          WHERE a.project_id = r.project_id AND a.session_id = r.session_id AND a.receipt_id = r.id))`;
const injection = (name: string, after: boolean) => slottedRead<ContextInjectionChildRow>(name,
  `SELECT kind, created_at, delivery, created_at AS order_at, kind FROM ${INJECTIONS}
    WHERE project_id = {project} AND session_id = {session}${after ? KEYSET.replace('{key}', 'kind') : ''}
    ORDER BY created_at ASC, kind ASC LIMIT {limit}`);
const injections = { first: injection('sessionChildren.contextFirst', false), after: injection('sessionChildren.contextAfter', true) };

interface ChildPage { project: string; session: string; after: { createdAt: number; id: string } | null; limit: number }
const keyed = (page: ChildPage) => ({ project: page.project, session: page.session, limit: page.limit, at: page.after?.createdAt ?? null, afterKey: page.after?.id ?? null });

/** Up to `limit` of the session's attachments in capture order, each with the prompt its hint places it on; narrowed to one prompt when named. */
export async function attachmentChildRows(db: RelationalStore, page: ChildPage & { prompt?: string }): Promise<AttachmentChildRow[]> {
  const variant = page.prompt === undefined ? (page.after === null ? attachments.first : attachments.after)
    : (page.after === null ? attachments.promptFirst : attachments.promptAfter);
  return readSlotted(db, variant, { ...keyed(page), prompt: page.prompt ?? null });
}

/** Up to `limit` of the records of context the session received that no prompt took, in capture order. */
export async function contextInjectionChildRows(db: RelationalStore, page: ChildPage): Promise<ContextInjectionChildRow[]> {
  return readSlotted(db, page.after === null ? injections.first : injections.after, keyed(page));
}
