/**
 * Card settlement, run by the publisher after it publishes.
 *
 * Each pass promotes the cards whose deadline has passed and settles the ready ones, newest source activity first; a card
 * not yet due stays where it is. A pending turn is read once from its pages: a turn the live document no longer holds
 * loses its card row, a turn whose input hash matches a carded turn of its session reuses that card, a turn the triage
 * rules match is carded `none`, and any other falls due for a model, with the material its card is built from. The
 * rules judge a whole turn only: a turn past the page budget, read at its head and its last page, always falls due.
 *
 * Every settlement is guarded on the turn's change count, and a postponement or a model-due mark also on its observed
 * deadline, so a turn the publisher changed meanwhile, or a concurrent pass, waits for its next settlement. A card this pass could not settle moves to a later
 * deadline, so it never answers that work remains while nothing can move it.
 */
import type { ServerEnv } from '../core/adapters.js';
import { trimTurn, triageTurn, TURN_QUIET_MS } from '../core/turn-card-rules.js';
import {
  cardOutline, cardStatements, forgetTurnStatement, NONE_CARD, reusableCard, turnMaterial, type DueTurn, type CardMarks,
} from '../core/turn-cards.js';
import { pendingCardsStatement, sessionProgressStatements } from '../core/learning-sessions.js';
import { SessionDocument } from '../content/session-pages.js';
import { documentTurn } from '../content/turn-material.js';
import { markCardModelDue, postponeCard, takeDueCards, type ReadyCard } from '../db/documents/card-settlement.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached } from './document-batch.js';
import { deferDocumentReadFailure } from './document-read-failures.js';
import type { PassLimits } from './parse.js';

/** Turns one wake settles at most. */
export const SETTLE_TURNS_PER_WAKE = 50;

type Settled = 'settled' | 'postponed' | 'stale';

/**
 * Settles the turns due for it, newest source activity first, within the wake's remaining budget. `more` holds only
 * when this pass moved a card and more remain due; a pass that moves nothing leaves the rest to the next wake.
 */
export async function settleCards(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ settled: number; more: boolean }> {
  const { ready, promotedFull } = await takeDueCards(env.db, now, SETTLE_TURNS_PER_WAKE + 1);
  const documents = new Map<string, Promise<SessionDocument | null>>();
  let settled = 0, moved = 0;
  for (const row of ready.slice(0, SETTLE_TURNS_PER_WAKE)) {
    if (limits.clock() >= limits.deadline || reserveReached(env.db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { settled, more: true };
    const key = JSON.stringify([row.projectId, row.sessionId]);
    try {
      if (!documents.has(key)) documents.set(key, SessionDocument.open(env, row.projectId, row.sessionId));
      const outcome = await settleTurn(env, row, await documents.get(key)!, now);
      moved += 1;
      if (outcome === 'settled') settled += 1;
    } catch (error) {
      const applied = await deferDocumentReadFailure(env.db, { project_id: row.projectId, session_id: row.sessionId, turnKey: row.turnKey, changes: row.changes, generation: row.generation, publication_input_revision: row.publication_input_revision }, error, now);
      if (applied || await postponeCard(env.db, row, now + TURN_QUIET_MS)) moved += 1;
    }
  }
  return { settled, more: moved > 0 && (ready.length > SETTLE_TURNS_PER_WAKE || promotedFull) };
}

async function settleTurn(env: Pick<ServerEnv, 'db' | 'blobs'>, row: ReadyCard, document: SessionDocument | null, now: number): Promise<Settled> {
  const { db } = env;
  const { projectId: p, sessionId: s } = row;
  const turn: DueTurn = { turnKey: row.turnKey, changes: row.changes };
  const unmoved = async (): Promise<Settled> => await postponeCard(db, row, now + TURN_QUIET_MS) ? 'postponed' : 'stale';
  if (document === null) return unmoved();
  const read = await documentTurn(env, p, s, turn.turnKey, document);
  if (read === null) {
    const [forgotten] = await db.batch([forgetTurnStatement(db, p, s, turn), pendingCardsStatement(db, p, s), ...sessionProgressStatements(db, p, s, now)]);
    return forgotten!.results.length > 0 ? 'settled' : unmoved();
  }
  const { input, complete } = read;
  const material = turnMaterial(trimTurn(input));
  const prior = await reusableCard(db, p, s, turn.turnKey);
  const rule = prior === null && complete ? triageTurn(input) : null;
  if (prior === null && rule === null) return await markCardModelDue(db, row, material, now) ? 'settled' : unmoved();
  const card = prior !== null
    ? { value: prior.fields ?? prior.card, outline: prior.headline === null || prior.marks === null ? cardOutline(prior.fields ?? prior.card) : { headline: prior.headline, marks: JSON.parse(prior.marks) as CardMarks },
      signal: prior.signal, reason: prior.reason, sharedWith: prior.turnKey === turn.turnKey ? null : prior.turnKey, covered: prior.covered === 1, runId: null, model: null }
    : { value: NONE_CARD(rule!), signal: 'none' as const, reason: rule!, sharedWith: null, covered: true, runId: null, model: null };
  const [carded] = await db.batch([...cardStatements(db, p, s, turn, card, now, material), ...sessionProgressStatements(db, p, s, now)]);
  return carded!.results.length > 0 ? 'settled' : unmoved();
}
