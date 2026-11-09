import { cardsWritten } from '../db/runs/attributed-writes.js';
import type { AttributedMutation } from '../db/runs/attribution.js';
import type { Bound } from '../db/index.js';
import { cardBackoffWrite, cardDueWrite } from '../db/runs/claim-companions.js';
import { encodeCard, cardFieldsError, readCard, renderCard, storedCardFields, type CardFields } from '@goondocks/myco-shared/turn-card';
import { DOCUMENT_PREVIEW_CHARS } from '../db/document-tables.js';
/**
 * Stage one of learning: one card per turn, written as turns complete.
 *
 * The publisher keeps each turn's card state: a turn it settles with a new input is pending and waits for settlement.
 * Settlement reads the turn's pages once: a turn whose input hashes equal to a carded turn of its session reuses that
 * card and its coverage, a turn the declared triage rules match is carded `none`, and any other turn falls due for a
 * model. A claim takes a session's due turns from the catalog alone, up to the per-run input budget, and that run writes
 * one card per turn. Every statement here reads catalog rows; none reads a document.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import { answerRoom, materialPages, type PagedEntry } from './material-pages.js';
import { CARD_MAX_CHARS, CARD_RUN_INPUT_CHARS } from './read-window.js';
import type { TrimmedTurn } from './turn-card-rules.js';
import { CARD_SIGNALS, type CardSignal } from './turn-card-prompt.js';
import { claimLearningRetryWrite, LEARNING_BACKOFF_MS, pendingCardsStatement, sessionProgressStatements } from './learning-sessions.js';
import { FRESH_LEARNING_MS, learningRangeSql } from '../db/runs/learning-policy.js';
import { learningHistoryEnabledSql } from './settings.js';
import { writeGuardBatch } from './write-guard-store.js';
import { SessionMaterialPendingError } from '../read/material-readiness.js';

/** Due turns one claim reads at most. */
export const CARD_CLAIM_TURNS = 64;
/** How long a claimed card run keeps its turns out of the due set before they are offered again. */
const CARD_RETRY_MS = 3_600_000;

/** A card claim advances the session backoff and holds its assigned turns until the claim is presumed lost. */
export function claimCardsWrites(db: RelationalStore, projectId: string, sessionId: string, turnKeys: readonly string[], now: number,
  run: { runId: string; dispatchedBy: string }): Bound[] {
  return [claimLearningRetryWrite(db, projectId, sessionId, run), cardBackoffWrite.bind(now - FRESH_LEARNING_MS, now, ...LEARNING_BACKOFF_MS, projectId, sessionId, run.runId, run.dispatchedBy),
    cardDueWrite.bind(now + CARD_RETRY_MS, projectId, sessionId, JSON.stringify(turnKeys), run.runId, run.dispatchedBy)];
}

/** The input hash the publisher stored for a card's turn in its session's live document. */
const LIVE_HASH = `(SELECT sp.input_hash FROM session_prompts sp JOIN session_documents d ON d.project_id = sp.project_id
  AND d.session_id = sp.session_id AND d.generation = sp.generation AND d.state = 'live'
  WHERE sp.project_id = turn_cards.project_id AND sp.session_id = turn_cards.session_id AND sp.prompt_id = turn_cards.turn_key)`;

const liveDocumentSql = (project: string, session: string) => `EXISTS (SELECT 1 FROM session_documents d
  WHERE d.project_id = ${project} AND d.session_id = ${session} AND d.state = 'live' AND d.generation IS NOT NULL)`;
const DOCUMENT_PENDING_PATH = '$[myco_card_document_pending]';

/** Card mutations require a live document in the same transaction. */
function cardMutationBatch(db: RelationalStore, projectId: string, sessionId: string, statements: PreparedStatement[]) {
  return writeGuardBatch(db, () => db.prepare(`SELECT CASE WHEN ${liveDocumentSql('?', '?')} THEN 1
      ELSE json_extract('[]', ?) END AS ready`).bind(projectId, sessionId, DOCUMENT_PENDING_PATH), error => {
    if (error instanceof Error && error.message.includes(DOCUMENT_PENDING_PATH.slice(1))) throw new SessionMaterialPendingError();
    throw error;
  }, statements);
}

interface CardWrite { turns: string[]; signal: CardSignal; card: CardFields }

export interface CardMarks { decisions: boolean; rejected: boolean; errors: boolean; corrections: boolean; openQuestions: boolean }

/** Outline fields of a rendered card, including cards read from an artifact. */
export function cardOutline(card: string | CardFields): { headline: string; marks: CardMarks } {
  const fields = typeof card === 'string' ? readCard(card) : card;
  if (fields !== null) return {
    headline: (fields.outcome || fields.done).slice(0, DOCUMENT_PREVIEW_CHARS),
    marks: { decisions: fields.decisions.length > 0, rejected: fields.rejected.length > 0, errors: fields.errors.length > 0,
      corrections: fields.corrections.length > 0, openQuestions: fields.open_questions.length > 0 },
  };
  const text = String(card);
  const fieldText = (name: string) => text.match(new RegExp('^' + name + ': *(.*)$', 'm'))?.[1]?.trim() ?? '';
  return {
    headline: (fieldText('Outcome') || fieldText('Done')).slice(0, DOCUMENT_PREVIEW_CHARS),
    marks: { decisions: /^Decisions:\n/m.test(text), rejected: /^Rejected:\n/m.test(text), errors: /^Errors:\n/m.test(text),
      corrections: /^Corrections:\n/m.test(text), openQuestions: /^Open questions:\n/m.test(text) },
  };
}

/** The card a turn the triage rules match takes. */
export const NONE_CARD = (reason: string): CardFields => ({
  asked: '', done: `mechanical turn (${reason})`, outcome: '', decisions: [], rejected: [], errors: [], corrections: [],
  files: [], commands: [], open_questions: [],
});

/** A card write as a run sends it, or the refusal that answers it. */
export function parseCardWrites(raw: unknown, assigned: ReadonlySet<string>): CardWrite[] | string {
  if (!Array.isArray(raw)) return 'cards must be an array';
  const seen = new Set<string>();
  const writes: CardWrite[] = [];
  for (const [index, entry] of (raw as Record<string, unknown>[]).entries()) {
    const label = `cards[${index}]`;
    const turns = entry?.turns;
    if (!Array.isArray(turns) || turns.length === 0 || !turns.every((t) => typeof t === 'string')) return `${label}.turns is ${JSON.stringify(turns) ?? 'missing'}; expected a nonempty array of served turn_key strings; available turns: ${[...assigned].join(', ')}`;
    for (const turn of turns as string[]) {
      if (!assigned.has(turn)) return `${label}.turns names unserved turn ${turn}; available turns: ${[...assigned].join(', ')}`;
      if (seen.has(turn)) return `turn ${turn} appears more than once (at ${label}.turns); every served turn appears in exactly one card`;
      seen.add(turn);
    }
    if (!(CARD_SIGNALS as readonly unknown[]).includes(entry.signal)) return `${label}.signal is ${JSON.stringify(entry.signal) ?? 'missing'}; expected none, low or high`;
    const invalid = cardFieldsError(entry.card);
    if (invalid !== null) return `${label}: ${invalid}`;
    const card = entry.card as CardFields;
    const chars = renderCard(card).length;
    if (chars > CARD_MAX_CHARS) return `${label} renders to ${chars} characters; the limit is ${CARD_MAX_CHARS}`;
    writes.push({ turns: turns as string[], signal: entry.signal as CardSignal, card });
  }
  return writes;
}

/** One turn's trimmed input as a card run reads it. `continues` marks an input that goes on under the same key on the next page. */
export interface CardMaterial { turn_key: string; input: string; continues?: true }

const CARD_ENTRY: PagedEntry<CardMaterial> = {
  textOf: (turn) => turn.input,
  withText: (turn, input, continues) => ({ turn_key: turn.turn_key, input, ...(continues ? { continues: true as const } : {}) }),
};

/** A card run's material as pages, each an answer the harness holds whole. */
export function cardMaterialPages(sessionId: string, turns: readonly CardMaterial[]): CardMaterial[][] {
  const room = answerRoom({ session_id: sessionId, turns: [] });
  return materialPages(turns, CARD_ENTRY, { first: room, rest: room });
}

/** A pending turn as a claim or settlement found it: its key and the change count its write is guarded by. */
export interface DueTurn { turnKey: string; changes: number }

/** The material settlement records on a turn: what its card is built from. */
export function turnMaterial(trimmed: TrimmedTurn): { records: string; inputChars: number; rawChars: number } {
  return { records: JSON.stringify(trimmed.records), inputChars: trimmed.text.length, rawChars: trimmed.rawChars };
}

/**
 * Write one turn's card, guarded on the change count the turn had at settlement. The card takes the input hash the
 * publisher stored for the turn, and an unchanged input keeps its coverage.
 */
export function cardStatements(
  db: RelationalStore, projectId: string, sessionId: string, turn: DueTurn,
  card: { value: CardFields | string; signal: CardSignal; reason: string; sharedWith: string | null; covered: boolean | null; runId: string | null; model: string | null;
    outline?: ReturnType<typeof cardOutline> },
  now: number, material?: ReturnType<typeof turnMaterial>,
): PreparedStatement[] {
  const fields = typeof card.value === 'string' ? null : card.value;
  const text = typeof card.value === 'string' ? card.value : renderCard(card.value);
  const outline = card.outline ?? cardOutline(card.value);
  return [
    db.prepare(`UPDATE turn_cards SET state = 'carded', due_at = NULL, settle_at = NULL,
        records = COALESCE(?, records), input_chars = COALESCE(?, input_chars), raw_chars = COALESCE(?, raw_chars),
        headline = ?, marks = ?, card = ?, fields = ?, signal = ?, signal_reason = ?, shared_with = ?,
        covered = CASE WHEN ? = 'none' THEN 1 WHEN ? IS NOT NULL THEN ? WHEN input_hash IS ${LIVE_HASH} THEN covered ELSE 0 END,
        input_hash = ${LIVE_HASH}, run_id = ?, model = ?, carded_at = ?
      WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ? AND ${LIVE_HASH} IS NOT NULL RETURNING turn_key`)
      .bind(material?.records ?? null, material?.inputChars ?? null, material?.rawChars ?? null,
        outline.headline, JSON.stringify(outline.marks), text, fields === null ? null : encodeCard(fields), card.signal, card.reason, card.sharedWith,
        card.signal, card.covered === null ? null : 1, card.covered ? 1 : 0,
        card.runId, card.model, now, projectId, sessionId, turn.turnKey, turn.changes),
  ];
}

/** The carded turn of the session whose input hash equals the one stored for `turnKey`, coverage first, or null. */
export async function reusableCard(db: RelationalStore, projectId: string, sessionId: string, turnKey: string):
  Promise<{ turnKey: string; card: string; fields: CardFields | null; signal: CardSignal; reason: string; covered: number; headline: string | null; marks: string | null } | null> {
  const row = await db.prepare(`SELECT c.turn_key AS turnKey, c.card,c.fields, c.signal, c.signal_reason AS reason, c.covered,c.headline,c.marks FROM turn_cards c INDEXED BY idx_turn_cards_reuse
    WHERE c.project_id = ?1 AND c.session_id = ?2 AND c.card IS NOT NULL AND c.input_hash = (SELECT sp.input_hash FROM session_prompts sp
      JOIN session_documents d ON d.project_id = sp.project_id AND d.session_id = sp.session_id AND d.generation = sp.generation AND d.state = 'live'
      WHERE sp.project_id = ?1 AND sp.session_id = ?2 AND sp.prompt_id = ?3)
    ORDER BY c.covered DESC LIMIT 1`).bind(projectId, sessionId, turnKey)
    .first<{ turnKey: string; card: string; fields: string | null; signal: CardSignal; reason: string; covered: number; headline: string | null; marks: string | null }>();
  return row === null ? null : { ...row, fields: storedCardFields(row.fields) };
}

/** A pending turn whose prompt the live document no longer holds. */
export function forgetTurnStatement(db: RelationalStore, projectId: string, sessionId: string, turn: DueTurn): PreparedStatement {
  return db.prepare(`DELETE FROM turn_cards WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?
      AND ${liveDocumentSql('turn_cards.project_id', 'turn_cards.session_id')}
      AND NOT EXISTS (SELECT 1 FROM session_prompts sp JOIN session_documents d ON d.project_id=sp.project_id
        AND d.session_id=sp.session_id AND d.generation=sp.generation AND d.state='live'
        WHERE sp.project_id=turn_cards.project_id AND sp.session_id=turn_cards.session_id
          AND sp.prompt_id=turn_cards.turn_key AND sp.turn_key=sp.prompt_id) RETURNING turn_key`)
    .bind(projectId, sessionId, turn.turnKey, turn.changes);
}

/**
 * The turns a card run of this session takes: its due turns in the order they fell due, up to one run's input budget,
 * from at most `CARD_CLAIM_TURNS` catalog rows. The index holds the order whole, so the read seeks the due range and
 * stops at its limit whatever the session holds: turns due at one instant, or turns postponed past now.
 */
export async function dueCardTurns(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<DueTurn[]> {
  const { results } = await db.prepare(`SELECT turn_key AS turnKey, changes, input_chars AS chars FROM turn_cards INDEXED BY idx_turn_cards_model_due
    WHERE project_id = ? AND session_id = ? AND state = 'pending' AND due_at IS NOT NULL AND due_at <= ?
      AND EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id = ?1 AND l.session_id = ?2 AND l.card_ready_at <= ${Math.floor(now)}
        AND (${learningRangeSql('cards', true, now)} OR ${learningHistoryEnabledSql()})) ORDER BY due_at, turn_key LIMIT ?`)
    .bind(projectId, sessionId, now, CARD_CLAIM_TURNS).all<DueTurn & { chars: number | null }>();
  const turns: DueTurn[] = [];
  let room = CARD_RUN_INPUT_CHARS;
  for (const row of results) {
    const chars = row.chars ?? 0;
    if (chars > room && turns.length > 0) continue;
    room -= chars;
    turns.push({ turnKey: row.turnKey, changes: row.changes });
  }
  return turns;
}

/** Assigned turns whose current material still needs this run's card. */
const remainingCardsSql = `FROM json_each(?) j
  LEFT JOIN turn_cards c ON c.project_id = ? AND c.session_id = ? AND c.turn_key = json_extract(j.value,'$.turnKey')
  WHERE c.changes = json_extract(j.value,'$.changes') AND (c.run_id IS NOT ? OR c.state <> 'carded')`;

/** The run's card completion lands once every assigned turn has a card or newer material. */
export function cardsWrittenStatement(_db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): AttributedMutation {
  return cardsWritten.bind(projectId,sessionId,JSON.stringify(turns),projectId,sessionId,runId);
}

/** Write a card run's cards for its served turns; a turn that changed after serving stays due. */
export async function writeRunCards(
  env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, assigned: readonly DueTurn[], writes: readonly CardWrite[],
  run: { runId: string; model: string | null }, now: number, unavailable: readonly DueTurn[] = [],
): Promise<{ written: number; changed: string[] }> {
  const { db } = env;
  await cardMutationBatch(db, projectId, sessionId, unavailable.length > 0 ? [
    ...unavailable.map(turn => forgetTurnStatement(db, projectId, sessionId, turn)),
    pendingCardsStatement(db, projectId, sessionId), ...sessionProgressStatements(db, projectId, sessionId, now),
  ] : []);
  const byKey = new Map(assigned.map((turn) => [turn.turnKey, turn]));
  const changed: string[] = [];
  let written = 0;
  for (const write of writes) {
    const [first, ...rest] = write.turns;
    for (const turnKey of write.turns) {
      const results = await cardMutationBatch(db, projectId, sessionId, [
        ...cardStatements(db, projectId, sessionId, byKey.get(turnKey)!, {
          value: write.card, signal: write.signal, reason: 'model', sharedWith: turnKey === first || rest.length === 0 ? null : first!,
          covered: null, runId: run.runId, model: run.model,
        }, now),
        ...sessionProgressStatements(db, projectId, sessionId, now),
      ]);
      // The card landed when its guarded update returned its turn; a trigger's own writes never count for it.
      if (results[0]!.results.length > 0) written += 1; else changed.push(turnKey);
    }
  }
  return { written, changed };
}

/** Whether this run has written every assigned turn that still holds its assigned material. */
export async function runCardsFinished(db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): Promise<boolean> {
  const row = await db.prepare(`SELECT COUNT(*) AS remaining ${remainingCardsSql}`)
    .bind(JSON.stringify(turns), projectId, sessionId, runId).first<{ remaining: number }>();
  return row?.remaining === 0;
}

/** Assigned unchanged turns still awaiting this run's cards. */
export async function runCardsRemaining(db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): Promise<string[]> {
  const rows = await db.prepare(`SELECT c.turn_key AS turnKey ${remainingCardsSql}`)
    .bind(JSON.stringify(turns),projectId,sessionId,runId).all<{turnKey:string}>();
  return rows.results.map(row => row.turnKey);
}

