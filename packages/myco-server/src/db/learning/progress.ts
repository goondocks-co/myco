import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';

/**
 * A session's derived progress: its eligibility, its bounded retry and whether it has finished with nothing to learn.
 *
 * The session's card counts are maintained by triggers, so this statement reads its own row and recounts no card; only
 * a session about to finish reads a card, to prove a carded one is newer than its last completion. It
 * runs after any card change in the same commit: `eligible_at` follows the counts and a session with cards written after
 * its last completion, none pending and none uncovered, records a completion with reason `no_signal`.
 */
const finished = `(init_state='ready' AND pending_cards=0 AND due_cards=0 AND last_carded_at IS NOT NULL AND last_carded_at>COALESCE(last_completed_at,-1)
    AND EXISTS(SELECT 1 FROM turn_cards c WHERE c.project_id=learning_sessions.project_id AND c.session_id=learning_sessions.session_id AND c.state='carded' AND c.carded_at>COALESCE(learning_sessions.last_completed_at,-1)))`;
const settled = (now: string) => `fresh_admitted=CASE WHEN pending_cards=0 AND due_cards=0 THEN 0 ELSE fresh_admitted END,
    eligible_at=CASE WHEN init_state='ready' AND skipped_by_owner=0 AND pending_cards=0 AND due_cards>0 THEN COALESCE(eligible_at,${now}) ELSE NULL END,
    learned_seq=CASE WHEN ${finished} THEN max_seq ELSE learned_seq END,
    last_completed_reason=CASE WHEN ${finished} THEN CASE WHEN last_completed_at=${now} AND last_completed_reason='completed' THEN 'completed' ELSE 'no_signal' END ELSE last_completed_reason END,
    last_completed_at=CASE WHEN ${finished} THEN ${now} ELSE last_completed_at END`;

const progress = write<[now: number, project: string, session: string]>({
  name: 'learningProgress.settle', sql: `UPDATE learning_sessions SET ${settled('?1')} WHERE project_id=?2 AND session_id=?3` });

/** The session's progress follows its card counts: commit this after any card change. */
export const sessionProgressStatement = (project: string, session: string, now: number): Bound =>
  progress.bind(now, project, session);

const SURVIVING = `(SELECT COUNT(*) FROM json_each(?6) j CROSS JOIN turn_cards c ON c.turn_key=json_extract(j.value,'$.turnKey')
    AND c.input_hash=json_extract(j.value,'$.inputHash') WHERE c.project_id=?2 AND c.session_id=?3 AND c.state='carded')`;
const LANDED = 'EXISTS(SELECT 1 FROM learning_sessions l WHERE l.project_id=?2 AND l.session_id=?3 AND l.revision=?4 AND l.last_completed_run=?5)';

const completionProgress = write<[now: number, project: string, session: string, landedRevision: number, run: string, assigned: string]>({
  name: 'learningProgress.completed', sql: `UPDATE learning_sessions SET ${settled('?1')}
    WHERE project_id=?2 AND session_id=?3 AND ${LANDED} AND ${SURVIVING}>0` });

/** Completion's progress holds only for the revision this run landed, and only when the slice covered a card. */
export const completionProgressStatement = (project: string, session: string, now: number, landedRevision: number, run: string, assigned: string): Bound =>
  completionProgress.bind(now, project, session, landedRevision, run, assigned);

const insertSession = write<[project: string, session: string]>({
  name: 'learningProgress.insert', sql: `INSERT OR IGNORE INTO learning_sessions (project_id,session_id,init_state,source_activity_at)
    VALUES (?1,?2,'ready',(SELECT last_record_at FROM session_documents WHERE project_id=?1 AND session_id=?2))` });

/** A published session's learning row, ready; a batch that has just inserted its cards still gets the exact count. */
export const learningSessionStatement = (project: string, session: string): Bound => insertSession.bind(project, session);

/** The learning row and its progress, written with a publication. */
export function publicationProgressStatements(project: string, session: string, now: number): Bound[] {
  return [learningSessionStatement(project, session), sessionProgressStatement(project, session, now)];
}

const held = read<[project: string, session: string], { revision: number; handoff: string | null }>({
  name: 'learningProgress.held', sql: 'SELECT revision,handoff FROM learning_sessions WHERE project_id=?1 AND session_id=?2' });
const assignedCards = read<[project: string, session: string, limit: number], { turnKey: string; inputHash: string; chars: number }>({
  name: 'learningProgress.assignable', sql: `SELECT turn_key AS turnKey,input_hash AS inputHash,length(card) AS chars FROM turn_cards
    INDEXED BY idx_turn_cards_uncovered WHERE project_id=?1 AND session_id=?2 AND state='carded' AND covered=0
    ORDER BY created_at,turn_key LIMIT ?3` });
/** The session's progress and its next slice of uncovered cards, oldest first. */
export async function assignableCards(db: RelationalStore, project: string, session: string, limit: number) {
  const [progressRows, cards] = await readSet(db, held.bind(project, session), assignedCards.bind(project, session, limit));
  return { progress: progressRows[0] ?? null, cards };
}

const quiet = read<[project: string, session: string, now: number], { quiet: number }>({
  name: 'learningProgress.quiet', sql: 'SELECT 1 AS quiet FROM learning_sessions WHERE project_id=?1 AND session_id=?2 AND quiet_at<=?3' });

export async function sessionQuiet(db: RelationalStore, project: string, session: string, now: number): Promise<boolean> {
  const [rows] = await readSet(db, quiet.bind(project, session, now));
  return rows.length > 0;
}

const assignedRows = read<[assignment: string, project: string, session: string], { turnKey: string; card: string; signal: string; records: string | null }>({
  name: 'learningProgress.assignedCards', sql: `SELECT c.turn_key AS turnKey,c.card,c.signal,c.records FROM json_each(?1) j
    CROSS JOIN turn_cards c ON c.project_id=?2 AND c.session_id=?3 AND c.turn_key=json_extract(j.value,'$.turnKey')
      AND c.input_hash=json_extract(j.value,'$.inputHash') AND c.state='carded'
    ORDER BY CAST(j.key AS INTEGER)` });

export async function assignedCardRows(db: RelationalStore, project: string, session: string, assignment: string) {
  const [rows] = await readSet(db, assignedRows.bind(assignment, project, session));
  return rows;
}

const coverCards = write<[project: string, session: string, assigned: string, landedRevision: number, run: string]>({
  name: 'learningProgress.cover', sql: `UPDATE turn_cards SET covered=1 WHERE state='carded' AND project_id=?1 AND session_id=?2
    AND turn_key IN (SELECT json_extract(value,'$.turnKey') FROM json_each(?3))
    AND input_hash=(SELECT json_extract(value,'$.inputHash') FROM json_each(?3) WHERE json_extract(value,'$.turnKey')=turn_cards.turn_key)
    AND EXISTS(SELECT 1 FROM learning_sessions l WHERE l.project_id=?1 AND l.session_id=?2 AND l.revision=?4 AND l.last_completed_run=?5)` });

/** Covers exactly the assigned cards whose input is unchanged, only for the revision this run landed. */
export const coverCardsStatement = (project: string, session: string, assigned: string, landedRevision: number, run: string): Bound =>
  coverCards.bind(project, session, assigned, landedRevision, run);

const ackRecord = write<[ackId: string, run: string, now: number, project: string, served: string, session: string, landedRevision: number, turn: string, inputHash: string]>({
  name: 'learningProgress.ackRecord', sql: `INSERT INTO extraction_acks (project_id,ack_id,session_id,kind,record_id,served_id,run_id,acknowledged_at)
    SELECT material.project_id,?1,material.session_id,'record',material.record_id,material.served_id,?2,?3
    FROM (SELECT m.project_id,m.record_id,m.session_id,m.served_id FROM run_served_material m WHERE m.run_id=?2 AND m.project_id=?4 AND m.served_id=?5) material
    JOIN sessions s ON s.project_id=material.project_id AND s.session_id=material.session_id
    WHERE ${notTombstonedSql('s')}
      AND EXISTS(SELECT 1 FROM learning_sessions l WHERE l.project_id=?4 AND l.session_id=?6 AND l.revision=?7 AND l.last_completed_run=?2)
      AND EXISTS(SELECT 1 FROM turn_cards c WHERE c.project_id=?4 AND c.session_id=?6 AND c.turn_key=?8 AND c.input_hash=?9 AND c.state='carded')
      AND NOT EXISTS (SELECT 1 FROM extraction_acks a WHERE a.project_id=material.project_id AND a.record_id=material.record_id AND a.kind='record' AND a.run_id=?2 AND a.served_id IS material.served_id)
    ON CONFLICT (project_id,served_id) DO NOTHING` });

/** Acknowledges one served record of a covered card, only for the revision this run landed and only while the card is unchanged. */
export const ackRecordStatement = (values: { ackId: string; run: string; now: number; project: string; served: string; session: string; landedRevision: number; turn: string; inputHash: string }): Bound =>
  ackRecord.bind(values.ackId, values.run, values.now, values.project, values.served, values.session, values.landedRevision, values.turn, values.inputHash);
