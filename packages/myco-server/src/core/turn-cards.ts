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
import { CARD_MAX_CHARS, CARD_RUN_INPUT_CHARS } from './read-window.js';
import type { TrimmedTurn } from './turn-card-rules.js';
import { CARD_FIELDS, CARD_SIGNALS, type CardSignal } from './turn-card-prompt.js';
import { sessionProgressStatements } from './learning-sessions.js';
export { CARD_TASK } from './task-catalogue.js';

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

export interface CardFields {
  asked: string; done: string; outcome: string;
  decisions: { decision: string; reason: string }[];
  rejected: { approach: string; reason: string }[];
  errors: { error: string; fix: string }[];
  corrections: { wrong: string; right: string }[];
  files: string[]; commands: string[]; open_questions: string[];
}
export interface CardWrite { turns: string[]; signal: CardSignal; card: CardFields }

/** A card as every reader sees it: its fields in their fixed order. */
export function renderCard(card: CardFields): string {
  const pairs = (items: readonly Record<string, string>[], a: string, b: string) =>
    items.map((item) => `- ${item[a]}${item[b] === '' ? '' : ` — ${b}: ${item[b]}`}`).join('\n');
  return [
    `Asked: ${card.asked}`, `Done: ${card.done}`, `Outcome: ${card.outcome}`,
    card.decisions.length === 0 ? '' : `Decisions:\n${pairs(card.decisions, 'decision', 'reason')}`,
    card.rejected.length === 0 ? '' : `Rejected:\n${pairs(card.rejected, 'approach', 'reason')}`,
    card.errors.length === 0 ? '' : `Errors:\n${pairs(card.errors, 'error', 'fix')}`,
    card.corrections.length === 0 ? '' : `Corrections:\n${pairs(card.corrections, 'wrong', 'right')}`,
    card.files.length === 0 ? '' : `Files: ${card.files.join(', ')}`,
    card.commands.length === 0 ? '' : `Commands:\n${card.commands.map((command) => `- ${command}`).join('\n')}`,
    card.open_questions.length === 0 ? '' : `Open questions:\n${card.open_questions.map((q) => `- ${q}`).join('\n')}`,
  ].filter((line) => line !== '').join('\n');
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
    if (card === undefined || typeof card !== 'object') return 'each card carries its fields';
    for (const field of CARD_FIELDS) {
      const value = card[field];
      const text = ['asked', 'done', 'outcome'].includes(field);
      if (text ? typeof value !== 'string' : !Array.isArray(value)) return `card field ${field} is missing or malformed`;
    }
    if (renderCard(card as unknown as CardFields).length > CARD_MAX_CHARS) return `a card runs past ${CARD_MAX_CHARS} characters`;
    writes.push({ turns: turns as string[], signal: entry.signal as CardSignal, card: card as unknown as CardFields });
  }
  if (seen.size !== assigned.size) return 'every served turn appears in one card';
  return writes;
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
  card: { text: string; signal: CardSignal; reason: string; sharedWith: string | null; covered: boolean | null; runId: string | null; model: string | null },
  now: number, material?: ReturnType<typeof turnMaterial>,
): PreparedStatement[] {
  return [
    db.prepare(`UPDATE turn_cards SET state = 'carded', due_at = NULL, settle_at = NULL,
        records = COALESCE(?, records), input_chars = COALESCE(?, input_chars), raw_chars = COALESCE(?, raw_chars),
        card = ?, signal = ?, signal_reason = ?, shared_with = ?,
        covered = CASE WHEN ? = 'none' THEN 1 WHEN ? IS NOT NULL THEN ? WHEN input_hash IS ${LIVE_HASH} THEN covered ELSE 0 END,
        input_hash = ${LIVE_HASH}, run_id = ?, model = ?, carded_at = ?
      WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
      .bind(material?.records ?? null, material?.inputChars ?? null, material?.rawChars ?? null,
        card.text, card.signal, card.reason, card.sharedWith,
        card.signal, card.covered === null ? null : 1, card.covered ? 1 : 0,
        card.runId, card.model, now, projectId, sessionId, turn.turnKey, turn.changes),
  ];
}

/** The carded turn of the session whose input hash equals the one stored for `turnKey`, coverage first, or null. */
export async function reusableCard(db: RelationalStore, projectId: string, sessionId: string, turnKey: string):
  Promise<{ turnKey: string; card: string; signal: CardSignal; reason: string; covered: number } | null> {
  return db.prepare(`SELECT c.turn_key AS turnKey, c.card, c.signal, c.signal_reason AS reason, c.covered FROM turn_cards c
    WHERE c.project_id = ?1 AND c.session_id = ?2 AND c.card IS NOT NULL AND c.input_hash = (SELECT sp.input_hash FROM session_prompts sp
      JOIN session_documents d ON d.project_id = sp.project_id AND d.session_id = sp.session_id AND d.generation = sp.generation AND d.state = 'live'
      WHERE sp.project_id = ?1 AND sp.session_id = ?2 AND sp.prompt_id = ?3)
    ORDER BY c.covered DESC LIMIT 1`).bind(projectId, sessionId, turnKey)
    .first<{ turnKey: string; card: string; signal: CardSignal; reason: string; covered: number }>();
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
 * The turns a card run of this session takes: its due turns oldest first, up to one run's input budget, from at most
 * `CARD_CLAIM_TURNS` catalog rows.
 */
export async function dueCardTurns(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<DueTurn[]> {
  const { results } = await db.prepare(`SELECT turn_key AS turnKey, changes, input_chars AS chars FROM turn_cards INDEXED BY idx_turn_cards_model_due
    WHERE project_id = ? AND session_id = ? AND state = 'pending' AND due_at IS NOT NULL AND due_at <= ? ORDER BY created_at, turn_key LIMIT ?`)
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
    const text = renderCard(write.card);
    const [first, ...rest] = write.turns;
    for (const turnKey of write.turns) {
      const results = await db.batch([
        ...cardStatements(db, projectId, sessionId, byKey.get(turnKey)!, {
          text, signal: write.signal, reason: 'model', sharedWith: turnKey === first || rest.length === 0 ? null : first!,
          covered: null, runId: run.runId, model: run.model,
        }, now),
        ...sessionProgressStatements(db, projectId, sessionId, now),
      ]);
      if ((results[0]!.meta.changes ?? 0) > 0) written += 1; else changed.push(turnKey);
    }
  }
  return { written, changed };
}
