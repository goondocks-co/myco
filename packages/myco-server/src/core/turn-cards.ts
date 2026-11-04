import { encodeCard, isCardFields, readCard, renderCard, storedCardFields, type CardFields } from '@goondocks/myco-shared/turn-card';
export { renderCard, type CardFields } from '@goondocks/myco-shared/turn-card';
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
import { sha256HexOf, utf8 } from '../hash.js';
import { RUN_CONTEXT_OBJECT_SQL } from './runs.js';
import { CARD_MAX_CHARS, CARD_RUN_INPUT_CHARS, RUN_ANSWER_BYTES } from './read-window.js';
import type { TrimmedTurn } from './turn-card-rules.js';
import { CARD_FIELDS, CARD_SIGNALS, type CardSignal } from './turn-card-prompt.js';
import { sessionProgressStatements } from './learning-sessions.js';
export { CARD_TASK } from './task-catalogue.js';
import { learningRecencySql } from './learning-recency.js';
import { learningHistoryEnabledSql } from './settings.js';

/** Due turns one claim reads at most. */
export const CARD_CLAIM_TURNS = 64;
/** How long a claimed card run keeps its turns out of the due set before they are offered again. */
export const CARD_RETRY_MS = 3_600_000;

/** The statement a claim of a card run adds to its batch: its turns leave the due set until the claim is presumed lost. */
export function claimCardsStatement(db: RelationalStore, projectId: string, sessionId: string, turnKeys: readonly string[], now: number,
  run: { runId: string; dispatchedBy: string }): PreparedStatement {
  return db.prepare(`UPDATE turn_cards SET due_at = ? WHERE project_id = ? AND session_id = ? AND state = 'pending'
      AND turn_key IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = turn_cards.project_id AND r.id = ? AND r.dispatched_by = ?)`)
    .bind(now + CARD_RETRY_MS, projectId, sessionId, JSON.stringify(turnKeys), run.runId, run.dispatchedBy);
}

/** The input hash the publisher stored for a card's turn in its session's live document. */
const LIVE_HASH = `(SELECT sp.input_hash FROM session_prompts sp JOIN session_documents d ON d.project_id = sp.project_id
  AND d.session_id = sp.session_id AND d.generation = sp.generation AND d.state = 'live'
  WHERE sp.project_id = turn_cards.project_id AND sp.session_id = turn_cards.session_id AND sp.prompt_id = turn_cards.turn_key)`;

export interface CardWrite { turns: string[]; signal: CardSignal; card: CardFields }

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
  if (!Array.isArray(raw) || raw.length === 0) return 'cards must be a nonempty array';
  const seen = new Set<string>();
  const writes: CardWrite[] = [];
  for (const entry of raw as Record<string, unknown>[]) {
    const turns = entry?.turns;
    if (!Array.isArray(turns) || turns.length === 0 || !turns.every((t) => typeof t === 'string')) return 'each card names its turns';
    for (const turn of turns as string[]) {
      if (!assigned.has(turn)) return `turn ${turn} was not served to this run`;
      if (seen.has(turn)) return `turn ${turn} appears in more than one card`;
      seen.add(turn);
    }
    if (!(CARD_SIGNALS as readonly unknown[]).includes(entry.signal)) return 'signal must be none, low or high';
    const card = entry.card as Record<string, unknown> | undefined;
    if (card === undefined || card === null || typeof card !== 'object' || Array.isArray(card)) return 'each card carries its fields';
    for (const field of CARD_FIELDS) {
      const value = card[field];
      const text = ['asked', 'done', 'outcome'].includes(field);
      if (text ? typeof value !== 'string' : !Array.isArray(value)) return `card field ${field} is missing or malformed`;
    }
    if (!isCardFields(card)) return 'card fields are malformed';
    if (renderCard(card).length > CARD_MAX_CHARS) return `a card runs past ${CARD_MAX_CHARS} characters`;
    writes.push({ turns: turns as string[], signal: entry.signal as CardSignal, card });
  }
  if (seen.size !== assigned.size) return 'every served turn appears in one card';
  return writes;
}

/** The characters of a material revision. */
const CARD_REVISION_CHARS = 16;
/** The refusal of a continuation whose material has moved past the revision its pages came from: read again from page 1. */
export const CARD_MATERIAL_CHANGED = 'material_changed';
/** The refusal of a read or a write ahead of the pages served: read the page it names. */
export const CARD_MATERIAL_UNREAD = 'material_unread';
const CARD_MATERIAL_READ_KEY = 'cardMaterial';

/** How far this attempt has read one revision of its material: every page up to and including `through`. */
export interface CardMaterialRead { tokenId: string; revision: string; pages: number; through: number }

/** What the material says now, as the token that binds its pages to one another. */
export async function cardMaterialRevision(turns: readonly CardMaterial[]): Promise<string> {
  return (await sha256HexOf(utf8(JSON.stringify(turns)))).slice(0, CARD_REVISION_CHARS);
}

/** How far the attempt holding this credential has read its material, or null where it has read none: another attempt's reads are not its own. */
export function cardMaterialRead(runContext: string | null, tokenId: string): CardMaterialRead | null {
  try {
    const read = (JSON.parse(runContext ?? 'null') as Record<string, CardMaterialRead> | null)?.[CARD_MATERIAL_READ_KEY];
    return read?.tokenId === tokenId ? read : null;
  } catch { return null; }
}

/** Record how far the attempt has read, in the one place the run keeps it; a later read replaces it, so it stays one small value. */
export async function recordCardMaterialRead(db: RelationalStore, projectId: string, runId: string, read: CardMaterialRead): Promise<void> {
  await db.prepare(`UPDATE agent_runs SET run_context = json_set(${RUN_CONTEXT_OBJECT_SQL}, '$.${CARD_MATERIAL_READ_KEY}', json(?))
    WHERE project_id = ? AND id = ? AND dispatched_by = ?`).bind(JSON.stringify(read), projectId, runId, read.tokenId).run();
}

/** One turn's trimmed input as a card run reads it. `continues` marks an input that goes on under the same key on the next page. */
export interface CardMaterial { turn_key: string; input: string; continues?: true }

const encoder = new TextEncoder();
const answerBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/**
 * The longest head of `input` whose entry weighs at most `room` bytes. It never ends inside a surrogate pair: JSON escapes
 * half a pair to six bytes, more than the four of the whole pair, so whichever head holds half a pair, the next one fits too.
 */
function headThatFits(turnKey: string, input: string, room: number): string {
  let low = 1;
  let high = Math.min(input.length, room);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (answerBytes({ turn_key: turnKey, input: input.slice(0, middle), continues: true }) <= room) low = middle;
    else high = middle - 1;
  }
  return input.slice(0, low);
}

/**
 * A card run's material as pages, each an answer the harness holds whole. Turns stay in order and every character is
 * served: a turn starts a new page rather than split, unless it is longer than a page.
 */
export function cardMaterialPages(sessionId: string, turns: readonly CardMaterial[]): CardMaterial[][] {
  const capacity = RUN_ANSWER_BYTES - answerBytes({ result: { session_id: sessionId, revision: '0'.repeat(CARD_REVISION_CHARS), page: 9_999, next_page: 9_999, turns: [] } });
  const pages: CardMaterial[][] = [[]];
  let room = capacity;
  const turnPage = () => { pages.push([]); room = capacity; };
  for (const turn of turns) {
    let input = turn.input;
    for (;;) {
      const entry = { turn_key: turn.turn_key, input };
      const weight = answerBytes(entry) + 1;
      if (weight > room && pages.at(-1)!.length > 0) turnPage();
      if (weight <= room) { pages.at(-1)!.push(entry); room -= weight; break; }
      const head = headThatFits(turn.turn_key, input, room - 1);
      pages.at(-1)!.push({ turn_key: turn.turn_key, input: head, continues: true });
      input = input.slice(head.length);
      turnPage();
    }
  }
  return pages;
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
      WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
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

/** A settled turn a model must card: due now, with the material its card is built from. */
export function modelDueStatement(db: RelationalStore, projectId: string, sessionId: string, turn: DueTurn,
  material: ReturnType<typeof turnMaterial>, now: number): PreparedStatement {
  return db.prepare(`UPDATE turn_cards SET due_at = ?, settle_at = NULL, records = ?, input_chars = ?, raw_chars = ?
    WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ? AND settle_at IS NOT NULL`)
    .bind(now, material.records, material.inputChars, material.rawChars, projectId, sessionId, turn.turnKey, turn.changes);
}

/** A pending turn whose prompt the live document no longer holds. */
export function forgetTurnStatement(db: RelationalStore, projectId: string, sessionId: string, turn: DueTurn): PreparedStatement {
  return db.prepare(`DELETE FROM turn_cards WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
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
      AND (EXISTS (SELECT 1 FROM learning_sessions l WHERE l.project_id = ?1 AND l.session_id = ?2 AND ${learningRecencySql(true, now)})
        OR ${learningHistoryEnabledSql()}) ORDER BY due_at, turn_key LIMIT ?`)
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

/** The run's card write as one attributed statement: it lands when the run wrote a card in this session. */
export function cardsWrittenStatement(db: RelationalStore, projectId: string, sessionId: string, runId: string): PreparedStatement {
  return db.prepare(`UPDATE turn_cards SET run_id = run_id WHERE project_id = ? AND session_id = ? AND run_id = ?`).bind(projectId, sessionId, runId);
}

/** Write a card run's cards for its served turns; a turn that changed after serving stays due. */
export async function writeRunCards(
  env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, assigned: readonly DueTurn[], writes: readonly CardWrite[],
  run: { runId: string; model: string | null }, now: number,
): Promise<{ written: number; changed: string[] }> {
  const { db } = env;
  const byKey = new Map(assigned.map((turn) => [turn.turnKey, turn]));
  const changed: string[] = [];
  let written = 0;
  for (const write of writes) {
    const [first, ...rest] = write.turns;
    for (const turnKey of write.turns) {
      const results = await db.batch([
        ...cardStatements(db, projectId, sessionId, byKey.get(turnKey)!, {
          value: write.card, signal: write.signal, reason: 'model', sharedWith: turnKey === first || rest.length === 0 ? null : first!,
          covered: null, runId: run.runId, model: run.model,
        }, now),
        ...sessionProgressStatements(db, projectId, sessionId, now),
      ]);
      if ((results[0]!.meta.changes ?? 0) > 0) written += 1; else changed.push(turnKey);
    }
  }
  return { written, changed };
}
