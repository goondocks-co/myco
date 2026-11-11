import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

export type AttachmentHookRow = {
  attachment_id: string; prompt_id: string | null; blob_key: string; media_type: string; byte_size: number; description: string | null; created_at: number;
};
export type AnswerHookRow = {
  id: string; prompt_id: string; created_at: number; outcome: string; context_chars: number; parts: string; skipped: string; failures: string; selection: string;
};
export type DeliveredReceiptRow = { prompt_id: string; id: string; spore_ids: string; created_at: number; plan_ids: string };

const ATTACHMENT_COLUMNS = 'r.attachment_id, r.prompt_id, r.blob_key, r.media_type, r.byte_size, r.description, r.created_at';
const ANSWER_COLUMNS = 'r.id, r.prompt_id, r.created_at, r.outcome, r.context_chars, r.parts, r.skipped, r.failures, r.selection';

/**
 * Each prompt's first page of a hook collection, read in its full order up to its row `rows + 1`, so the statement
 * reads no further into a prompt's rows than its page and the row that shows another follows.
 */
const firstPage = (table: string, columns: string, id: string, rows: number) => {
  const nth = (column: string) => `(SELECT x.${column} FROM ${table} x WHERE x.project_id = ?1 AND x.session_id = ?2 AND x.prompt_id = j.value
      ORDER BY x.created_at, x.${id} LIMIT 1 OFFSET ${rows})`;
  return `WITH b AS (SELECT j.value AS prompt_id, COALESCE(${nth('created_at')}, ${Number.MAX_SAFE_INTEGER}) AS at, COALESCE(${nth(id)}, '') AS id
      FROM json_each(?3) j)
  SELECT ${columns} FROM b CROSS JOIN ${table} r INDEXED BY idx_${table}_prompt_order
    ON r.project_id = ?1 AND r.session_id = ?2 AND r.prompt_id = b.prompt_id AND (r.created_at, r.${id}) <= (b.at, b.id)
  ORDER BY r.prompt_id, r.created_at, r.${id}`;
};

type Prompts = [project: string, session: string, prompts: string];

/** Rows each hook collection carries before its continuation. */
export const HOOK_ROWS = 50;
const attachments = read<Prompts, AttachmentHookRow>({ name: 'turnHooks.attachments', sql: firstPage('attachments', ATTACHMENT_COLUMNS, 'attachment_id', HOOK_ROWS) });
const answers = read<Prompts, AnswerHookRow>({ name: 'turnHooks.answers', sql: firstPage('prompt_context_answers', ANSWER_COLUMNS, 'id', HOOK_ROWS) });
const receipts = read<Prompts, DeliveredReceiptRow>({ name: 'turnHooks.receipts', sql:
  `SELECT i.delivered_prompt_id AS prompt_id, i.id, i.spore_ids, i.created_at, COALESCE(i.plan_ids, '[]') AS plan_ids
      FROM json_each(?3) j CROSS JOIN spore_injections i ON i.project_id = ?1 AND i.session_id = ?2
        AND i.id = (SELECT x.id FROM spore_injections x INDEXED BY idx_spore_injections_delivered_at
          WHERE x.project_id = ?1 AND x.session_id = ?2 AND x.delivered_prompt_id = j.value ORDER BY x.created_at DESC LIMIT 1)` });

/** The first page of attachments and context answers recorded for each of these prompts, and the context last served for each. */
export async function hookRecordPages(db: RelationalStore, project: string, session: string, promptIds: readonly string[]) {
  const ids = JSON.stringify(promptIds);
  const [attached, answered, served] = await readSet(db, attachments.bind(project, session, ids), answers.bind(project, session, ids), receipts.bind(project, session, ids));
  return { attachments: attached, answers: answered, receipts: served };
}

type Collection = [project: string, session: string, prompt: string, limit: number];
type CollectionAfter = [project: string, session: string, prompt: string, limit: number, createdAt: number, id: string];
const attachmentSelect = `SELECT attachment_id, prompt_id, blob_key, media_type, byte_size, description, created_at FROM attachments INDEXED BY idx_attachments_prompt_order
       WHERE project_id = ?1 AND session_id = ?2 AND prompt_id = ?3`;
const answerSelect = `SELECT id, prompt_id, created_at, outcome, context_chars, parts, skipped, failures, selection FROM prompt_context_answers INDEXED BY idx_prompt_context_answers_prompt_order
       WHERE project_id = ?1 AND session_id = ?2 AND prompt_id = ?3`;
const attachmentsFirst = read<Collection, AttachmentHookRow>({ name: 'turnHooks.attachmentsFirst', sql: `${attachmentSelect} ORDER BY created_at, attachment_id LIMIT ?4` });
const attachmentsAfter = read<CollectionAfter, AttachmentHookRow>({ name: 'turnHooks.attachmentsAfter', sql:
  `${attachmentSelect} AND (created_at, attachment_id) > (?5, ?6) ORDER BY created_at, attachment_id LIMIT ?4` });
const answersFirst = read<Collection, AnswerHookRow>({ name: 'turnHooks.answersFirst', sql: `${answerSelect} ORDER BY created_at, id LIMIT ?4` });
const answersAfter = read<CollectionAfter, AnswerHookRow>({ name: 'turnHooks.answersAfter', sql:
  `${answerSelect} AND (created_at, id) > (?5, ?6) ORDER BY created_at, id LIMIT ?4` });

/** Up to `limit` of one prompt's attachments or context answers in creation order, after the key `(createdAt, id)` when given. */
export async function hookCollectionRows(db: RelationalStore, request: { project: string; session: string; prompt: string; collection: 'attachments' | 'answers';
  after: { createdAt: number; id: string } | null; limit: number }): Promise<(AttachmentHookRow | AnswerHookRow)[]> {
  const { project, session, prompt, collection, after, limit } = request;
  if (collection === 'attachments') {
    const [rows] = await readSet(db, after === null ? attachmentsFirst.bind(project, session, prompt, limit) : attachmentsAfter.bind(project, session, prompt, limit, after.createdAt, after.id));
    return rows;
  }
  const [rows] = await readSet(db, after === null ? answersFirst.bind(project, session, prompt, limit) : answersAfter.bind(project, session, prompt, limit, after.createdAt, after.id));
  return rows;
}
