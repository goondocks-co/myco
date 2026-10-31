/**
 * Card settlement, run by the publisher after it publishes.
 *
 * A pending turn whose `settle_at` has passed is read once from its pages. A turn the live document no longer holds
 * loses its card row; a turn whose input hash matches a carded turn of its session reuses that card; a turn the triage
 * rules match is carded `none`; any other falls due for a model, with the material its card is built from. The rules
 * judge a whole turn only: a turn past the page budget, read at its head and its last page, always falls due. Every
 * write is guarded on the turn's change count, so a turn the publisher changed meanwhile waits for its next settlement.
 */
import type { ServerEnv } from '../core/adapters.js';
import { trimTurn, triageTurn, TURN_QUIET_MS } from '../core/turn-card-rules.js';
import {
  cardStatements, forgetTurnStatement, modelDueStatement, NONE_CARD, renderCard, reusableCard, turnMaterial, type DueTurn,
} from '../core/turn-cards.js';
import { pendingCardsStatement, sessionProgressStatements } from '../core/learning-sessions.js';
import { SessionDocument } from '../content/session-pages.js';
import { documentTurn } from '../content/turn-material.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached } from './document-batch.js';
import type { PassLimits } from './parse.js';

/** Turns one wake settles at most. */
export const SETTLE_TURNS_PER_WAKE = 50;

interface SettleRow extends DueTurn { projectId: string; sessionId: string }

/** Settles the turns due for it, oldest first, within the wake's remaining budget. */
export async function settleCards(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ settled: number; more: boolean }> {
  const { results } = await env.db.prepare(`SELECT project_id AS projectId, session_id AS sessionId, turn_key AS turnKey, changes
    FROM turn_cards INDEXED BY idx_turn_cards_settle WHERE state = 'pending' AND settle_at <= ?
    ORDER BY settle_at, project_id, session_id, turn_key LIMIT ?`).bind(now, SETTLE_TURNS_PER_WAKE + 1).all<SettleRow>();
  const documents = new Map<string, Promise<SessionDocument | null>>();
  let settled = 0;
  for (const row of results.slice(0, SETTLE_TURNS_PER_WAKE)) {
    if (limits.clock() >= limits.deadline || reserveReached(env.db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { settled, more: true };
    const key = JSON.stringify([row.projectId, row.sessionId]);
    if (!documents.has(key)) documents.set(key, SessionDocument.open(env, row.projectId, row.sessionId));
    await settleTurn(env, row, await documents.get(key)!, now);
    settled += 1;
  }
  return { settled, more: results.length > SETTLE_TURNS_PER_WAKE };
}

async function settleTurn(env: Pick<ServerEnv, 'db' | 'blobs'>, row: SettleRow, document: SessionDocument | null, now: number): Promise<void> {
  const { db } = env;
  const { projectId: p, sessionId: s } = row;
  const turn: DueTurn = { turnKey: row.turnKey, changes: row.changes };
  if (document === null) {
    await db.prepare(`UPDATE turn_cards SET settle_at = ? WHERE project_id = ? AND session_id = ? AND turn_key = ? AND state = 'pending' AND changes = ?`)
      .bind(now + TURN_QUIET_MS, p, s, turn.turnKey, turn.changes).run();
    return;
  }
  const read = await documentTurn(env, p, s, turn.turnKey, document);
  if (read === null) {
    await db.batch([forgetTurnStatement(db, p, s, turn), pendingCardsStatement(db, p, s), ...sessionProgressStatements(db, p, s, now)]);
    return;
  }
  const { input, complete } = read;
  const material = turnMaterial(trimTurn(input));
  const prior = await reusableCard(db, p, s, turn.turnKey);
  const rule = prior === null && complete ? triageTurn(input) : null;
  if (prior === null && rule === null) {
    await modelDueStatement(db, p, s, turn, material, now).run();
    return;
  }
  const card = prior !== null
    ? { text: prior.card, signal: prior.signal, reason: prior.reason, sharedWith: prior.turnKey === turn.turnKey ? null : prior.turnKey, covered: prior.covered === 1, runId: null, model: null }
    : { text: renderCard(NONE_CARD(rule!)), signal: 'none' as const, reason: rule!, sharedWith: null, covered: true, runId: null, model: null };
  await db.batch([...cardStatements(db, p, s, turn, card, now, material), ...sessionProgressStatements(db, p, s, now)]);
}
