import { changed, trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';

/**
 * Where each context delivery landed, kept apart by what is known of it: `selected` (chosen, no delivery recorded),
 * `delivered` (on a prompt the session's live document holds), `unnamed` (delivered, naming no prompt) and `unavailable`
 * (naming a prompt the live document does not hold). One row per spore receipt and per served answer that carries no
 * receipt, re-derived by key whenever a trigger or a catch-up page names it; triggers on the row move the day counters.
 */
export const CONTEXT_PLACEMENT_PROJECTION = 'context_placements';
export const CONTEXT_PLACEMENT_RECEIPT_PHASE = 'contextPlacementReceipts';
export const CONTEXT_PLACEMENT_ANSWER_PHASE = 'contextPlacementAnswers';
export const CONTEXT_PLACEMENT_DAY_MS = 86_400_000;

const placedSql = (project: string, session: string, prompt: string) => `EXISTS (SELECT 1 FROM session_prompts p WHERE p.project_id=${project} AND p.session_id=${session}
  AND p.generation=(SELECT d.generation FROM session_documents d WHERE d.project_id=${project} AND d.session_id=${session} AND d.state='live') AND p.prompt_id=${prompt})`;
const notTombstoned = (project: string, session: string) => `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=${project} AND t.session_id=${session})`;

const RECEIPT_STATE = `CASE WHEN r.delivered_at IS NULL THEN 'selected' WHEN r.delivered_prompt_id IS NULL THEN 'unnamed'
  WHEN ${placedSql('r.project_id', 'r.session_id', 'r.delivered_prompt_id')} THEN 'delivered' ELSE 'unavailable' END`;
const ANSWER_STATE = `CASE WHEN a.delivered_at IS NULL THEN 'selected'
  WHEN ${placedSql('a.project_id', 'a.session_id', 'a.delivered_prompt_id')} OR ${placedSql('a.project_id', 'a.session_id', 'a.prompt_id')} THEN 'delivered'
  WHEN a.delivered_prompt_id IS NULL THEN 'unnamed' ELSE 'unavailable' END`;
const ANSWER_COUNTS = `a.outcome='served' AND NOT EXISTS (SELECT 1 FROM spore_injections receipt WHERE receipt.project_id=a.project_id AND receipt.session_id=a.session_id AND receipt.id=a.receipt_id)`;

const updateIfChanged = `ON CONFLICT(project_id,session_id,kind,record_id) DO UPDATE SET created_at=excluded.created_at,prompt_hint=excluded.prompt_hint,fallback_prompt=excluded.fallback_prompt,state=excluded.state
  WHERE context_placements.state IS NOT excluded.state OR context_placements.prompt_hint IS NOT excluded.prompt_hint OR context_placements.created_at IS NOT excluded.created_at OR context_placements.fallback_prompt IS NOT excluded.fallback_prompt`;

/** Re-derive the receipt keys `keys` (columns `project_id,session_id,id`). */
export function reconcileReceiptPlacements(keys: string): string[] {
  return [
    `DELETE FROM context_placements WHERE kind='receipt' AND (project_id,session_id,record_id) IN (SELECT project_id,session_id,id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM spore_injections r WHERE r.project_id=context_placements.project_id AND r.session_id=context_placements.session_id AND r.id=context_placements.record_id AND ${notTombstoned('r.project_id', 'r.session_id')})`,
    `INSERT INTO context_placements(project_id,session_id,kind,record_id,created_at,prompt_hint,fallback_prompt,state)
      SELECT r.project_id,r.session_id,'receipt',r.id,r.created_at,r.delivered_prompt_id,NULL,${RECEIPT_STATE}
      FROM (${keys}) key JOIN spore_injections r ON r.project_id=key.project_id AND r.session_id=key.session_id AND r.id=key.id WHERE ${notTombstoned('r.project_id', 'r.session_id')} ${updateIfChanged}`,
  ];
}

/** Re-derive the answer keys `keys` (columns `project_id,session_id,id`): only a served answer with no receipt of its own has a row. */
export function reconcileAnswerPlacements(keys: string): string[] {
  return [
    `DELETE FROM context_placements WHERE kind='answer' AND (project_id,session_id,record_id) IN (SELECT project_id,session_id,id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM prompt_context_answers a WHERE a.project_id=context_placements.project_id AND a.session_id=context_placements.session_id AND a.id=context_placements.record_id AND ${ANSWER_COUNTS} AND ${notTombstoned('a.project_id', 'a.session_id')})`,
    `INSERT INTO context_placements(project_id,session_id,kind,record_id,created_at,prompt_hint,fallback_prompt,state)
      SELECT a.project_id,a.session_id,'answer',a.id,a.created_at,a.delivered_prompt_id,a.prompt_id,${ANSWER_STATE}
      FROM (${keys}) key JOIN prompt_context_answers a ON a.project_id=key.project_id AND a.session_id=key.session_id AND a.id=key.id WHERE ${ANSWER_COUNTS} AND ${notTombstoned('a.project_id', 'a.session_id')} ${updateIfChanged}`,
  ];
}

const rowKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.session_id AS session_id,${row}.id AS id`;
const sessionReceipts = (row: string) => `SELECT project_id,session_id,id FROM spore_injections WHERE project_id=${row}.project_id AND session_id=${row}.session_id`;
const sessionAnswers = (row: string) => `SELECT project_id,session_id,id FROM prompt_context_answers WHERE project_id=${row}.project_id AND session_id=${row}.session_id`;
const answersOfReceipt = (row: string) => `SELECT project_id,session_id,id FROM prompt_context_answers WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND receipt_id=${row}.id`;
const wholeSession = (row: string) => [...reconcileReceiptPlacements(sessionReceipts(row)), ...reconcileAnswerPlacements(sessionAnswers(row))];
const promptReceipts = (row: string) => `SELECT project_id,session_id,id FROM spore_injections WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND delivered_prompt_id=${row}.prompt_id`;
const promptAnswers = (row: string) => `SELECT project_id,session_id,id FROM prompt_context_answers WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND delivered_prompt_id=${row}.prompt_id
  UNION SELECT project_id,session_id,id FROM prompt_context_answers WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND prompt_id=${row}.prompt_id`;
/** Only the deliveries that name this prompt, sought through their own indexes, whatever else the session holds. */
const namingPrompt = (row: string) => [...reconcileReceiptPlacements(promptReceipts(row)), ...reconcileAnswerPlacements(promptAnswers(row))];
const dayBump = (row: string, delta: '+1' | '-1') => `INSERT INTO context_placement_days(day,state,project_id,n) VALUES(${row}.created_at/${CONTEXT_PLACEMENT_DAY_MS},${row}.state,${row}.project_id,${delta})
  ON CONFLICT(day,state,project_id) DO UPDATE SET n=n${delta}`;
const liveGeneration = (row: string) => `${row}.generation=(SELECT d.generation FROM session_documents d WHERE d.project_id=${row}.project_id AND d.session_id=${row}.session_id AND d.state='live')`;

/** The derived tables, their triggers and the catch-up seed, as one schema step freezes them. */
export function contextPlacementSchemaStatements(): string[] {
  const receiptSource = ['delivered_at', 'delivered_prompt_id', 'created_at'];
  const answerSource = ['outcome', 'delivered_at', 'delivered_prompt_id', 'prompt_id', 'receipt_id', 'created_at'];
  return [
    `CREATE TABLE IF NOT EXISTS context_placements(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('receipt','answer')),record_id TEXT NOT NULL,created_at INTEGER NOT NULL,prompt_hint TEXT,fallback_prompt TEXT,
      state TEXT NOT NULL CHECK (state IN ('selected','delivered','unnamed','unavailable')),
      PRIMARY KEY(project_id,session_id,kind,record_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS context_placement_days(day INTEGER NOT NULL,state TEXT NOT NULL,project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),n INTEGER NOT NULL,
      PRIMARY KEY(day,state,project_id)) WITHOUT ROWID`,
    ...[
      trigger('context_placement_receipt_insert', 'spore_injections', 'INSERT', [...reconcileReceiptPlacements(rowKey('NEW')), ...reconcileAnswerPlacements(answersOfReceipt('NEW'))]),
      trigger('context_placement_receipt_update', 'spore_injections', `UPDATE OF ${receiptSource.join(',')}`, reconcileReceiptPlacements(rowKey('NEW')), changed(receiptSource)),
      trigger('context_placement_receipt_delete', 'spore_injections', 'DELETE', [...reconcileReceiptPlacements(rowKey('OLD')), ...reconcileAnswerPlacements(answersOfReceipt('OLD'))]),
      trigger('context_placement_answer_insert', 'prompt_context_answers', 'INSERT', reconcileAnswerPlacements(rowKey('NEW'))),
      trigger('context_placement_answer_update', 'prompt_context_answers', `UPDATE OF ${answerSource.join(',')}`, reconcileAnswerPlacements(rowKey('NEW')), changed(answerSource)),
      trigger('context_placement_answer_delete', 'prompt_context_answers', 'DELETE', reconcileAnswerPlacements(rowKey('OLD'))),
      trigger('context_placement_prompt_insert', 'session_prompts', 'INSERT', namingPrompt('NEW'), liveGeneration('NEW')),
      trigger('context_placement_prompt_delete', 'session_prompts', 'DELETE', namingPrompt('OLD'), liveGeneration('OLD')),
      trigger('context_placement_document_insert', 'session_documents', 'INSERT', wholeSession('NEW'), "NEW.state='live'"),
      trigger('context_placement_document_update', 'session_documents', 'UPDATE OF state,generation', wholeSession('NEW'), changed(['state', 'generation'])),
      trigger('context_placement_document_delete', 'session_documents', 'DELETE', wholeSession('OLD'), `OLD.state='live' AND ${notTombstoned('OLD.project_id', 'OLD.session_id')}`),
      trigger('context_placement_tombstone_insert', 'session_tombstones', 'INSERT', 'DELETE FROM context_placements WHERE project_id=NEW.project_id AND session_id=NEW.session_id'),
      trigger('context_placement_tombstone_delete', 'session_tombstones', 'DELETE', wholeSession('OLD')),
      trigger('context_placement_row_insert', 'context_placements', 'INSERT', dayBump('NEW', '+1')),
      trigger('context_placement_row_update', 'context_placements', 'UPDATE OF state,created_at', [dayBump('OLD', '-1'), dayBump('NEW', '+1')], changed(['state', 'created_at'])),
      trigger('context_placement_row_delete', 'context_placements', 'DELETE', dayBump('OLD', '-1')),
    ].map(built => built.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${CONTEXT_PLACEMENT_PROJECTION}','${CONTEXT_PLACEMENT_RECEIPT_PHASE}',NOT EXISTS(SELECT 1 FROM spore_injections) ON CONFLICT DO NOTHING`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${CONTEXT_PLACEMENT_PROJECTION}','${CONTEXT_PLACEMENT_ANSWER_PHASE}',NOT EXISTS(SELECT 1 FROM prompt_context_answers) ON CONFLICT DO NOTHING`,
  ];
}
