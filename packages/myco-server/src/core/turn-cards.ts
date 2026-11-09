import { cardsWritten } from '../db/runs/attributed-writes.js';
import type { AttributedMutation } from '../db/runs/attribution.js';
import { refused, type Bound } from '../db/index.js';
import { cardBackoffWrite, cardDueWrite } from '../db/runs/claim-companions.js';
import { CARD_DOCUMENT_PENDING, cardsRemaining, claimableCardTurns, commitCardWrites, forgetTurnStatement, reusableCardRow, writeCardStatement, type DueTurn } from '../db/learning/cards.js';
import { sessionProgressStatement } from '../db/learning/progress.js';
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
import type { RelationalStore, ServerEnv } from './adapters.js';
import { answerRoom, materialPages, type PagedEntry } from './material-pages.js';
import { CARD_MAX_CHARS, CARD_RUN_INPUT_CHARS } from './read-window.js';
import type { TrimmedTurn } from './turn-card-rules.js';
import { CARD_SIGNALS, type CardSignal } from './turn-card-prompt.js';
import { claimLearningRetryWrite, LEARNING_BACKOFF_MS } from './learning-sessions.js';
import { FRESH_LEARNING_MS } from '../db/runs/learning-policy.js';
import { SessionMaterialPendingError } from '../db/sessions/material.js';

/** Due turns one claim reads at most. */
export const CARD_CLAIM_TURNS = 64;
/** How long a claimed card run keeps its turns out of the due set before they are offered again. */
const CARD_RETRY_MS = 3_600_000;

/** A card claim advances the session backoff and holds its assigned turns until the claim is presumed lost. */
export function claimCardsWrites(projectId: string, sessionId: string, turnKeys: readonly string[], now: number,
  run: { runId: string; dispatchedBy: string }): Bound[] {
  return [claimLearningRetryWrite(projectId, sessionId, run), cardBackoffWrite.bind(now - FRESH_LEARNING_MS, now, ...LEARNING_BACKOFF_MS, projectId, sessionId, run.runId, run.dispatchedBy),
    cardDueWrite.bind(now + CARD_RETRY_MS, projectId, sessionId, JSON.stringify(turnKeys), run.runId, run.dispatchedBy)];
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

/** The material settlement records on a turn: what its card is built from. */
export function turnMaterial(trimmed: TrimmedTurn): { records: string; inputChars: number; rawChars: number } {
  return { records: JSON.stringify(trimmed.records), inputChars: trimmed.text.length, rawChars: trimmed.rawChars };
}

/**
 * Write one turn's card, guarded on the change count the turn had at settlement. The card takes the input hash the
 * publisher stored for the turn, and an unchanged input keeps its coverage. The contribution counts follow by trigger.
 */
export function cardWriteStatement(
  projectId: string, sessionId: string, turn: DueTurn,
  card: { value: CardFields | string; signal: CardSignal; reason: string; sharedWith: string | null; covered: boolean | null; runId: string | null; model: string | null;
    outline?: ReturnType<typeof cardOutline> },
  now: number, material?: ReturnType<typeof turnMaterial>,
) {
  const fields = typeof card.value === 'string' ? null : card.value;
  const text = typeof card.value === 'string' ? card.value : renderCard(card.value);
  const outline = card.outline ?? cardOutline(card.value);
  return writeCardStatement(projectId, sessionId, turn, {
    headline: outline.headline, marks: JSON.stringify(outline.marks), card: text, fields: fields === null ? null : encodeCard(fields),
    signal: card.signal, reason: card.reason, sharedWith: card.sharedWith, covered: card.covered, runId: card.runId, model: card.model,
  }, now, material);
}

/** The carded turn of the session whose input hash equals the one stored for `turnKey`, coverage first, or null. */
export async function reusableCard(db: RelationalStore, projectId: string, sessionId: string, turnKey: string):
  Promise<{ turnKey: string; card: string; fields: CardFields | null; signal: CardSignal; reason: string; covered: number; headline: string | null; marks: string | null } | null> {
  const row = await reusableCardRow(db, projectId, sessionId, turnKey);
  return row === null ? null : { ...row, signal: row.signal as CardSignal, fields: storedCardFields(row.fields) };
}

/**
 * The turns a card run of this session takes: its due turns in the order they fell due, up to one run's input budget,
 * from at most `CARD_CLAIM_TURNS` catalog rows. The index holds the order whole, so the read seeks the due range and
 * stops at its limit whatever the session holds: turns due at one instant, or turns postponed past now.
 */
export async function dueCardTurns(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<DueTurn[]> {
  const rows = await claimableCardTurns(db, projectId, sessionId, now, CARD_CLAIM_TURNS, now - FRESH_LEARNING_MS);
  const turns: DueTurn[] = [];
  let room = CARD_RUN_INPUT_CHARS;
  for (const row of rows) {
    const chars = row.chars ?? 0;
    if (chars > room && turns.length > 0) continue;
    room -= chars;
    turns.push({ turnKey: row.turnKey, changes: row.changes });
  }
  return turns;
}

/** The run's card completion lands once every assigned turn has a card or newer material. */
export function cardsWrittenStatement(_db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): AttributedMutation {
  return cardsWritten.bind(projectId,sessionId,JSON.stringify(turns),projectId,sessionId,runId);
}

/** Commit card writes while the session's document is live; a batch whose document left live refuses retryably. */
async function commitWhileLive<const Statements extends readonly Bound[]>(db: RelationalStore, projectId: string, sessionId: string, ...statements: Statements) {
  try { return await commitCardWrites(db, projectId, sessionId, ...statements); }
  catch (error) {
    if (refused(error, CARD_DOCUMENT_PENDING)) throw new SessionMaterialPendingError();
    throw error;
  }
}

/** Write a card run's cards for its served turns; a turn that changed after serving stays due. */
export async function writeRunCards(
  env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, assigned: readonly DueTurn[], writes: readonly CardWrite[],
  run: { runId: string; model: string | null }, now: number, unavailable: readonly DueTurn[] = [],
): Promise<{ written: number; changed: string[] }> {
  const { db } = env;
  await commitWhileLive(db, projectId, sessionId, ...unavailable.map(turn => forgetTurnStatement(projectId, sessionId, turn)),
    ...(unavailable.length > 0 ? [sessionProgressStatement(projectId, sessionId, now)] : []));
  const byKey = new Map(assigned.map((turn) => [turn.turnKey, turn]));
  const changed: string[] = [];
  let written = 0;
  for (const write of writes) {
    const [first, ...rest] = write.turns;
    for (const turnKey of write.turns) {
      const [card] = await commitWhileLive(db, projectId, sessionId,
        cardWriteStatement(projectId, sessionId, byKey.get(turnKey)!, {
          value: write.card, signal: write.signal, reason: 'model', sharedWith: turnKey === first || rest.length === 0 ? null : first!,
          covered: null, runId: run.runId, model: run.model,
        }, now),
        sessionProgressStatement(projectId, sessionId, now));
      // The card landed when its guarded update returned its turn; a trigger's own writes never count for it.
      if (card.results.length > 0) written += 1; else changed.push(turnKey);
    }
  }
  return { written, changed };
}

/** Whether this run has written every assigned turn that still holds its assigned material. */
export async function runCardsFinished(db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): Promise<boolean> {
  return (await cardsRemaining(db, projectId, sessionId, runId, turns)).count === 0;
}

/** Assigned unchanged turns still awaiting this run's cards. */
export async function runCardsRemaining(db: RelationalStore, projectId: string, sessionId: string, runId: string, turns: readonly DueTurn[]): Promise<string[]> {
  return (await cardsRemaining(db, projectId, sessionId, runId, turns)).keys;
}
