import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, refusalCode, write, type Bound } from '../index.js';
import { learningHistoryEnabledSql } from '../../db/settings/admission.js';

/**
 * The writes and reads of one turn's card. Per-session contributions move through the triggers on `turn_cards`, so a
 * caller commits a card transition beside `sessionProgress` and recounts nothing.
 */

/** The input hash the publisher stored for a card's turn in its session's live document. */
const LIVE_HASH = `(SELECT sp.input_hash FROM session_prompts sp JOIN session_documents d ON d.project_id = sp.project_id
  AND d.session_id = sp.session_id AND d.generation = sp.generation AND d.state = 'live'
  WHERE sp.project_id = turn_cards.project_id AND sp.session_id = turn_cards.session_id AND sp.prompt_id = turn_cards.turn_key)`;

const liveDocument = (project: string, session: string) => `EXISTS (SELECT 1 FROM session_documents d
  WHERE d.project_id = ${project} AND d.session_id = ${session} AND d.state = 'live' AND d.generation IS NOT NULL)`;

export interface DueTurn { turnKey: string; changes: number }

export const CARD_DOCUMENT_PENDING = refusalCode('myco_card_document_pending');
const documentLive = assertion<[project: string, session: string]>({
  name: 'learningCards.documentLive', when: liveDocument('?1', '?2'), refusal: CARD_DOCUMENT_PENDING,
});

/** A card's model or settlement output, as stored. */
export interface StoredCard {
  headline: string; marks: string; card: string; fields: string | null;
  signal: string; reason: string; sharedWith: string | null;
  /** The coverage a reused card carries, or null to keep it unless the input changed. */
  covered: boolean | null;
  runId: string | null; model: string | null;
}

export interface CardMaterialColumns { records: string; inputChars: number; rawChars: number }

const writeCard = write<[records: string | null, inputChars: number | null, rawChars: number | null, headline: string, marks: string, card: string, fields: string | null, signal: string, reason: string, sharedWith: string | null,
  coveredKnown: number | null, covered: number, runId: string | null, model: string | null, now: number, project: string, session: string, turn: string, changes: number], { turn_key: string }>({
  name: 'learningCards.write', sql: `UPDATE turn_cards SET state='carded',due_at=NULL,settle_at=NULL,
    records=COALESCE(?1,records),input_chars=COALESCE(?2,input_chars),raw_chars=COALESCE(?3,raw_chars),
    headline=?4,marks=?5,card=?6,fields=?7,signal=?8,signal_reason=?9,shared_with=?10,
    covered=CASE WHEN ?8='none' THEN 1 WHEN ?11 IS NOT NULL THEN ?12 WHEN input_hash IS ${LIVE_HASH} THEN covered ELSE 0 END,
    input_hash=${LIVE_HASH},run_id=?13,model=?14,carded_at=?15
    WHERE project_id=?16 AND session_id=?17 AND turn_key=?18 AND state='pending' AND changes=?19 AND ${LIVE_HASH} IS NOT NULL
    RETURNING turn_key` });

/** Write one turn's card, guarded on the change count the turn had at settlement. */
export function writeCardStatement(project: string, session: string, turn: DueTurn, card: StoredCard, now: number, material?: CardMaterialColumns): Bound<{ turn_key: string }, 'write'> {
  return writeCard.bind(material?.records ?? null, material?.inputChars ?? null, material?.rawChars ?? null,
    card.headline, card.marks, card.card, card.fields, card.signal, card.reason, card.sharedWith,
    card.covered === null ? null : 1, card.covered ? 1 : 0, card.runId, card.model, now, project, session, turn.turnKey, turn.changes);
}

const forget = write<[project: string, session: string, turn: string, changes: number], { turn_key: string }>({
  name: 'learningCards.forget', sql: `DELETE FROM turn_cards WHERE project_id=?1 AND session_id=?2 AND turn_key=?3 AND state='pending' AND changes=?4
    AND ${liveDocument('turn_cards.project_id', 'turn_cards.session_id')}
    AND NOT EXISTS (SELECT 1 FROM session_prompts sp JOIN session_documents d ON d.project_id=sp.project_id
      AND d.session_id=sp.session_id AND d.generation=sp.generation AND d.state='live'
      WHERE sp.project_id=turn_cards.project_id AND sp.session_id=turn_cards.session_id
        AND sp.prompt_id=turn_cards.turn_key AND sp.turn_key=sp.prompt_id) RETURNING turn_key` });

/** Drops a pending turn whose prompt the live document no longer holds. */
export const forgetTurnStatement = (project: string, session: string, turn: DueTurn): Bound<{ turn_key: string }, 'write'> =>
  forget.bind(project, session, turn.turnKey, turn.changes);

/** Commit card writes only while the session's document is live: a refused batch changes nothing. */
export async function commitCardWrites<const Statements extends readonly Bound[]>(db: RelationalStore, project: string, session: string, ...statements: Statements) {
  const [, ...results] = await commit(db, documentLive.bind(project, session), ...statements);
  return results;
}

interface ReusableRow { turnKey: string; card: string; fields: string | null; signal: string; reason: string; covered: number; headline: string | null; marks: string | null }
const reusable = read<[project: string, session: string, turn: string], ReusableRow>({
  name: 'learningCards.reusable', sql: `SELECT c.turn_key AS turnKey,c.card,c.fields,c.signal,c.signal_reason AS reason,c.covered,c.headline,c.marks FROM turn_cards c INDEXED BY idx_turn_cards_reuse
    WHERE c.project_id=?1 AND c.session_id=?2 AND c.card IS NOT NULL AND c.input_hash=(SELECT sp.input_hash FROM session_prompts sp
      JOIN session_documents d ON d.project_id=sp.project_id AND d.session_id=sp.session_id AND d.generation=sp.generation AND d.state='live'
      WHERE sp.project_id=?1 AND sp.session_id=?2 AND sp.prompt_id=?3)
    ORDER BY c.covered DESC LIMIT 1` });

/** The carded turn of the session whose input hash equals the one stored for `turn`, coverage first, or null. */
export async function reusableCardRow(db: RelationalStore, project: string, session: string, turn: string): Promise<ReusableRow | null> {
  const [rows] = await readSet(db, reusable.bind(project, session, turn));
  return rows[0] ?? null;
}

const remaining = (columns: string) => `SELECT ${columns} FROM json_each(?1) j
  LEFT JOIN turn_cards c ON c.project_id=?2 AND c.session_id=?3 AND c.turn_key=json_extract(j.value,'$.turnKey')
  WHERE c.changes=json_extract(j.value,'$.changes') AND (c.run_id IS NOT ?4 OR c.state<>'carded')`;
const remainingCount = read<[turns: string, project: string, session: string, run: string], { remaining: number }>({ name: 'learningCards.remainingCount', sql: remaining('COUNT(*) AS remaining') });
const remainingKeys = read<[turns: string, project: string, session: string, run: string], { turnKey: string }>({ name: 'learningCards.remainingKeys', sql: remaining('c.turn_key AS turnKey') });

/** Assigned turns whose current material still needs this run's card. */
export async function cardsRemaining(db: RelationalStore, project: string, session: string, run: string, turns: readonly DueTurn[]): Promise<{ count: number; keys: string[] }> {
  const json = JSON.stringify(turns);
  const [[count], keys] = await readSet(db, remainingCount.bind(json, project, session, run), remainingKeys.bind(json, project, session, run));
  return { count: count?.remaining ?? 0, keys: keys.map(row => row.turnKey) };
}

interface ClaimableTurn { turnKey: string; changes: number; chars: number | null }
const claimableTurns = read<[project: string, session: string, now: number, limit: number, cutoff: number], ClaimableTurn>({
  name: 'learningCards.claimable', sql: `SELECT turn_key AS turnKey,changes,input_chars AS chars FROM turn_cards INDEXED BY idx_turn_cards_model_due
    WHERE project_id=?1 AND session_id=?2 AND state='pending' AND due_at IS NOT NULL AND due_at<=?3
      AND EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id=?1 AND l.session_id=?2 AND l.card_ready_at<=?3
        AND (l.source_activity_at>?5 OR (l.fresh_admitted=1 AND l.card_failures<4) OR ${learningHistoryEnabledSql()}))
    ORDER BY due_at,turn_key LIMIT ?4` });

/** A session's turns due for a model at `now`, oldest first, up to `limit`. */
export async function claimableCardTurns(db: RelationalStore, project: string, session: string, now: number, limit: number, cutoff: number): Promise<ClaimableTurn[]> {
  const [rows] = await readSet(db, claimableTurns.bind(project, session, now, limit, cutoff));
  return rows;
}

const missingHeadlines = read<[limit: number], { project_id: string; session_id: string; turn_key: string; card: string; fields: string | null }>({
  name: 'learningCards.missingHeadlines', sql: 'SELECT project_id,session_id,turn_key,card,fields FROM turn_cards INDEXED BY idx_turn_cards_headline WHERE card IS NOT NULL AND headline IS NULL LIMIT ?1' });

/** The cards the publisher fills a headline for, one page per pass. */
export async function cardsMissingHeadlines(db: RelationalStore, limit: number) {
  const [rows] = await readSet(db, missingHeadlines.bind(limit));
  return rows;
}

const headlineWrite = write<[headline: string, marks: string, project: string, session: string, turn: string, card: string, fields: string | null]>({
  name: 'learningCards.headline', sql: 'UPDATE turn_cards SET headline=?1,marks=?2 WHERE project_id=?3 AND session_id=?4 AND turn_key=?5 AND card=?6 AND fields IS ?7 AND headline IS NULL' });

export const cardHeadlineStatement = (...values: [headline: string, marks: string, project: string, session: string, turn: string, card: string, fields: string | null]): Bound =>
  headlineWrite.bind(...values);
