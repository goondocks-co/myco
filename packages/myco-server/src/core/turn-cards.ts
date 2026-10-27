/**
 * Stage one of learning: one card per turn, written as turns complete.
 *
 * A turn falls due when its session's next top-level prompt arrives, when it has been quiet (`schema-v106`), or when a
 * publication gives one of its records a newer material version (`sessionPublishedStatements`). Due turns are read
 * through the read module: a published session from its view's records, a session with no transcript from its facts. Code settles
 * what it can with no model call: a turn whose trimmed input hashes equal to a carded turn of its session reuses that
 * card and its coverage, and a turn the declared triage rules match is carded `none`. The rest go to one cheap run per
 * batch, up to the per-run input budget, and that run writes one card per turn.
 */
import type { PreparedStatement, RelationalStore, ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { turnDetail } from '../read/turns.js';
import { listToolCalls } from '../read/children.js';
import { sha256Hex } from '../hash.js';
import { CARD_MAX_CHARS, CARD_RUN_INPUT_CHARS } from './read-window.js';
import { trimTurn, triageTurn, type TrimmedTurn, type TurnInput } from './turn-card-rules.js';
import { CARD_FIELDS, CARD_SIGNALS, type CardSignal } from './turn-card-prompt.js';
import { sessionProgressStatements } from './learning-sessions.js';
export { CARD_TASK } from './task-catalogue.js';

/** Due turns one settling pass reads before it stops. */
const SETTLE_TURNS = 200;
const TOOL_PAGE = 100;

/** One turn read through the read module, or null when no prompt of that key sits in the session. */
export async function readTurn(db: RelationalStore, scope: ReadScope, sessionId: string, turnKey: string): Promise<TurnInput | null> {
  const detail = await turnDetail(db, scope, sessionId, turnKey);
  if (detail === null) return null;
  const promptIds = [turnKey, ...detail.children.map((child) => child.prompt.promptId)];
  const tools = (await Promise.all(promptIds.map((promptId) => listToolCalls(db, scope, sessionId, { promptId, limit: TOOL_PAGE }))))
    .flatMap((page) => page.rows)
    .sort((a, b) => a.createdAt - b.createdAt || a.toolCallId.localeCompare(b.toolCallId));
  const replies = [...detail.responses, ...detail.children.flatMap((child) => child.responses)]
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    turnKey,
    origin: detail.prompt.origin,
    prompt: detail.prompt.text ?? '',
    steering: detail.children.map((child) => ({ promptId: child.prompt.promptId, text: child.prompt.text ?? '' })),
    replies: replies.map((reply) => ({ responseId: reply.responseId, text: reply.text ?? '' })),
    tools: tools.map((tool) => ({
      toolCallId: tool.toolCallId, toolName: tool.toolName, input: tool.inputPreview, output: tool.outputPreview,
      success: tool.success, errorMessage: tool.errorMessage,
    })),
    plans: detail.plans.map((plan) => ({ planKey: plan.planKey, title: plan.title, status: plan.status, content: plan.content })),
  };
}

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

const NONE_CARD = (reason: string): CardFields => ({
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

export interface CardRecord {
  turnKey: string;
  changes: number;
  trimmed: TrimmedTurn;
  inputHash: string;
}

/**
 * Write one turn's card in a batch guarded on the turn being unchanged after its read. The card's material range is
 * the current material versions of the records behind it, and an unchanged input keeps its coverage.
 */
export function cardStatements(
  db: RelationalStore, projectId: string, sessionId: string, record: CardRecord,
  card: { text: string; signal: CardSignal; reason: string; sharedWith: string | null; covered: boolean | null; runId: string | null; model: string | null },
  now: number,
): PreparedStatement[] {
  const records = JSON.stringify(record.trimmed.records);
  const range = (fn: 'MIN' | 'MAX') => `(SELECT ${fn}(v.material_seq) FROM json_each(?) r JOIN material_versions v ON v.project_id = ? AND v.session_id = ?
    AND v.kind = json_extract(r.value, '$[0]') AND v.record_id = json_extract(r.value, '$[1]'))`;
  return [
    db.prepare(`UPDATE turn_cards SET state = 'carded', due_at = NULL, claimed_until = NULL,
        first_seq = ${range('MIN')}, last_seq = ${range('MAX')},
        records = ?, input_chars = ?, raw_chars = ?, card = ?, signal = ?, signal_reason = ?, shared_with = ?,
        covered = CASE WHEN ? = 'none' THEN 1 WHEN ? IS NOT NULL THEN ? WHEN input_hash IS ? THEN covered ELSE 0 END,
        input_hash = ?, run_id = ?, model = ?, carded_at = ?
      WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
      .bind(records, projectId, sessionId, records, projectId, sessionId,
        records, record.trimmed.text.length, record.trimmed.rawChars, card.text, card.signal, card.reason, card.sharedWith,
        card.signal, card.covered === null ? null : 1, card.covered ? 1 : 0, record.inputHash,
        record.inputHash, card.runId, card.model, now, projectId, sessionId, record.turnKey, record.changes),
  ];
}

/** A due turn as one settling pass found it. */
export interface DueTurn { turnKey: string; changes: number }

async function dueTurns(db: RelationalStore, projectId: string, sessionId: string, now: number): Promise<DueTurn[]> {
  const { results } = await db.prepare(`SELECT turn_key AS turnKey, changes FROM turn_cards
    WHERE project_id = ? AND session_id = ? AND state = 'pending' AND due_at <= ? ORDER BY created_at, turn_key LIMIT ?`)
    .bind(projectId, sessionId, now, SETTLE_TURNS).all<DueTurn>();
  return results;
}

/** The record a turn's write is guarded by, with the turn behind it, or null when its prompt is gone from the session. */
export async function cardRecord(db: RelationalStore, scope: ReadScope, sessionId: string, turn: DueTurn): Promise<(CardRecord & { input: TurnInput }) | null> {
  const input = await readTurn(db, scope, sessionId, turn.turnKey);
  if (input === null) return null;
  const trimmed = trimTurn(input);
  return { turnKey: turn.turnKey, changes: turn.changes, trimmed, inputHash: await sha256Hex(trimmed.text), input };
}

/**
 * Card what code can and answer the turns left for a model, oldest first, up to one run's input budget. Reuse and
 * rule triage are written here, in the session's own batches, so no run is spent on them.
 */
export async function settleTurns(env: Pick<ServerEnv, 'db'>, projectId: string, sessionId: string, now: number): Promise<{ ruled: number; reused: number; forModel: CardRecord[] }> {
  const { db } = env;
  const scope = { projectId };
  const forModel: CardRecord[] = [];
  let ruled = 0;
  let reused = 0;
  let room = CARD_RUN_INPUT_CHARS;
  for (const turn of await dueTurns(db, projectId, sessionId, now)) {
    const record = await cardRecord(db, scope, sessionId, turn);
    if (record === null) {
      await db.prepare(`DELETE FROM turn_cards WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
        .bind(projectId, sessionId, turn.turnKey, turn.changes).run();
      continue;
    }
    const prior = await db.prepare(`SELECT turn_key AS turnKey, card, signal, signal_reason AS reason, covered FROM turn_cards
      WHERE project_id = ? AND session_id = ? AND input_hash = ? AND card IS NOT NULL ORDER BY covered DESC LIMIT 1`)
      .bind(projectId, sessionId, record.inputHash).first<{ turnKey: string; card: string; signal: CardSignal; reason: string; covered: number }>();
    const rule = prior === null ? triageTurn(record.input) : null;
    if (prior !== null || rule !== null) {
      const card = prior !== null
        ? { text: prior.card, signal: prior.signal, reason: prior.reason, sharedWith: prior.turnKey === turn.turnKey ? null : prior.turnKey, covered: prior.covered === 1, runId: null, model: null }
        : { text: renderCard(NONE_CARD(rule!)), signal: 'none' as const, reason: rule!, sharedWith: null, covered: true, runId: null, model: null };
      await db.batch([...cardStatements(db, projectId, sessionId, record, card, now), ...sessionProgressStatements(db, projectId, sessionId, now)]);
      if (prior !== null) reused += 1; else ruled += 1;
      continue;
    }
    if (record.trimmed.text.length > room && forModel.length > 0) continue;
    room -= record.trimmed.text.length;
    forModel.push(record);
  }
  return { ruled, reused, forModel };
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
      const record = await cardRecord(db, { projectId }, sessionId, byKey.get(turnKey)!);
      if (record === null) continue;
      const results = await db.batch([
        ...cardStatements(db, projectId, sessionId, record, {
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
