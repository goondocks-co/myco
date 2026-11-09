import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, write } from '../index.js';

/**
 * Card settlement selection and the writes settlement owns. A pass promotes the cards whose deadline has passed into
 * the ready set, then settles from the ready set newest source activity first: the promotion and the selection share
 * one commit, so a pass reads at most its promotion page and its ready page whatever else is pending. A card is
 * promoted at the deadline it holds, so any later write to its deadline takes it out of the ready set by itself.
 */

/** Cards one pass promotes at most; newest deadlines first, so the turns that just fell due are ready this pass. */
export const SETTLE_PROMOTE_PAGE = 500;

export interface ReadyCard {
  projectId: string;
  sessionId: string;
  turnKey: string;
  changes: number;
  settleAt: number;
  generation: number | null;
  publication_input_revision: number | null;
}

export type ObservedCard = Pick<ReadyCard, 'projectId' | 'sessionId' | 'turnKey' | 'changes' | 'settleAt'>;

const promote = write<[now: number, limit: number], { turn_key: string }>({ name: 'cardSettlement.promote', sql: `
  UPDATE turn_cards SET settle_promoted_at=settle_at WHERE rowid IN (
    SELECT rowid FROM turn_cards INDEXED BY idx_turn_cards_settle_deadline
    WHERE state='pending' AND settle_at IS NOT NULL AND settle_promoted_at IS NOT settle_at AND settle_at<=?1
    ORDER BY settle_at DESC,project_id,session_id,turn_key LIMIT ?2)
  RETURNING turn_key` });

const readyPage = read<[now: number, limit: number], ReadyCard>({ name: 'cardSettlement.readyPage', sql: `
  SELECT c.project_id AS projectId,c.session_id AS sessionId,c.turn_key AS turnKey,c.changes,c.settle_at AS settleAt,d.generation,d.publication_input_revision
  FROM turn_cards c INDEXED BY idx_turn_cards_settle_ready
  LEFT JOIN session_documents d ON d.project_id=c.project_id AND d.session_id=c.session_id AND d.state='live'
  WHERE c.state='pending' AND c.settle_at IS NOT NULL AND c.settle_promoted_at=c.settle_at AND c.settle_at<=?1
  ORDER BY c.source_activity_at DESC,c.project_id,c.session_id,c.turn_key LIMIT ?2` });

/** The ready cards of one pass, and whether the promotion filled its page, leaving more cards due behind it. */
export async function takeDueCards(db: RelationalStore, now: number, limit: number): Promise<{ ready: ReadyCard[]; promotedFull: boolean }> {
  const [promoted, ready] = await commit(db, promote.bind(now, SETTLE_PROMOTE_PAGE), readyPage.bind(now, limit));
  return { ready: ready.results, promotedFull: promoted.results.length === SETTLE_PROMOTE_PAGE };
}

const postpone = write<[next: number, project: string, session: string, turn: string, changes: number, settleAt: number], { turn_key: string }>({
  name: 'cardSettlement.postpone', sql: `UPDATE turn_cards SET settle_at=?1 WHERE project_id=?2 AND session_id=?3 AND turn_key=?4
    AND state='pending' AND changes=?5 AND settle_at=?6 RETURNING turn_key` });

/** Moves a card this pass could not settle to its next deadline; false when another writer already moved it. */
export async function postponeCard(db: RelationalStore, card: ObservedCard, next: number): Promise<boolean> {
  return (await first(db, postpone.bind(next, card.projectId, card.sessionId, card.turnKey, card.changes, card.settleAt))) !== null;
}

const modelDue = write<[now: number, records: string, inputChars: number, rawChars: number, project: string, session: string, turn: string, changes: number, settleAt: number], { turn_key: string }>({
  name: 'cardSettlement.modelDue', sql: `UPDATE turn_cards SET due_at=?1,settle_at=NULL,records=?2,input_chars=?3,raw_chars=?4
    WHERE project_id=?5 AND session_id=?6 AND turn_key=?7 AND state='pending' AND changes=?8 AND settle_at=?9 RETURNING turn_key` });

/** A settled turn a model must card: due now, with the material its card is built from. False when the card moved first. */
export async function markCardModelDue(db: RelationalStore, card: ObservedCard, material: { records: string; inputChars: number; rawChars: number }, now: number): Promise<boolean> {
  return (await first(db, modelDue.bind(now, material.records, material.inputChars, material.rawChars,
    card.projectId, card.sessionId, card.turnKey, card.changes, card.settleAt))) !== null;
}
