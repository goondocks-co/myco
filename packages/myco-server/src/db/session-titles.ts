import { commit, readSet, read, write } from './index.js';
import { attributedUpdate } from './runs/attribution.js';
import { prepareBound } from './kernel/statement.js';
import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import { commitAttributedWrite, titleRunInFlightSql, type RunWrite } from '../core/runs.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { sessionMaterialReadySql, titlingClaimAvailableSql, transcriptsPublishedSql } from '../read/material-readiness.js';
import { SQL_NOW_MS } from '../core/run-deadline.js';

const stamp = read<[string, string], { titled_at: number | null }>({ name: 'sessionTitle.stamp', sql: 'SELECT titled_at FROM sessions WHERE project_id = ? AND session_id = ?' });
const claimAutomatic = write<[number, string, string, number | null, number, number | null], { session_id: string }>({ name: 'sessionTitle.claimAutomatic', sql: `UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at IS ? AND (ended_at IS NOT NULL OR last_received_at <= ?) AND ${titlingClaimAvailableSql('sessions')} AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const claimRefresh = write<[number, string, string, number, number], { session_id: string }>({ name: 'sessionTitle.claimRefresh', sql: `UPDATE sessions SET titled_at = ?, title_material_at = COALESCE(title_material_at, titled_at) WHERE project_id = ? AND session_id = ? AND titled_at = ? AND titled_at <= ? AND title IS NOT NULL AND last_received_at > COALESCE(title_material_at, titled_at)
      AND NOT ${titleRunInFlightSql('sessions')} AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const claimOwner = write<[number, string, string, number], { session_id: string }>({ name: 'sessionTitle.claimOwner', sql: `UPDATE sessions SET titled_at = ?, title_material_at = CASE WHEN title IS NULL THEN title_material_at ELSE COALESCE(title_material_at, titled_at) END WHERE project_id = ? AND session_id = ? AND (titled_at IS NULL OR titled_at < ?) AND ${sessionMaterialReadySql('sessions')} RETURNING session_id` });
const restore = write<[number | null, string, string, number], never>({ name: 'sessionTitle.restore', sql: `UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at = ?` });
const titledPrompts = write<[string, string], never>({ name: 'sessionTitle.titledPrompts', sql: `UPDATE session_documents SET titled_user_prompts = user_prompts
    WHERE project_id = ? AND session_id = ? AND state = 'live'` });
const overwrite = attributedUpdate<[string, string, string | null, string, string]>('sessionTitle.overwrite', 'sessions', `title = ?1, summary = ?2, titled_by = ?3, title_material_at = COALESCE(titled_at, ${SQL_NOW_MS})`, `project_id = ?4 AND session_id = ?5 AND ${notTombstonedSql('sessions')} AND ${transcriptsPublishedSql('sessions')}`, 'session_id', 'project_id=?4 AND session_id=?5 AND title IS ?1 AND summary IS ?2 AND titled_by IS ?3');
const writeFirst = attributedUpdate<[string, string, string, string]>('sessionTitle.writeFirst', 'sessions', `title = ?1, summary = ?2, title_material_at = COALESCE(titled_at, ${SQL_NOW_MS})`, `project_id = ?3 AND session_id = ?4 AND title IS NULL AND ${notTombstonedSql('sessions')} AND ${transcriptsPublishedSql('sessions')}`, 'session_id', 'project_id=?3 AND session_id=?4 AND title IS ?1 AND summary IS ?2');

/** The session's titling stamp as it stands, or null when the project holds no such session. */
const titlingStamp = (db: RelationalStore, projectId: string, sessionId: string) =>
  readSet(db, stamp.bind(projectId, sessionId)).then(([rows]) => rows[0] ?? null);


/**
 * Claims the first automatic attempt on a session that has ended or, given `idleBefore`, gone quiet (its last receipt at or before
 * that instant), or, given `retryBefore`, a retry of one that ended untitled with its stamp before that instant; null admits a
 * first attempt only. Answers the stamp it replaced, so an attempt that never launches can put exactly that back.
 */
export async function claimTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, retryBefore: number | null, idleBefore: number | null = null): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const previous = row.titled_at ?? null;
  const [result] = await commit(db, claimAutomatic.bind(nowMs, projectId, sessionId, previous, idleBefore ?? 0, retryBefore));
  return { claimed: result.results.length === 1, previous };
}


/**
 * Claims the refresh of a titled session, open or ended: its title stamped at or before `refreshBefore`, a later receipt, and no
 * title run of it in flight. Stamps `titled_at`, which holds the next refresh off for the interval and leaves `title_material_at`,
 * the material of the standing title, where it is; answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimRefreshTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, refreshBefore: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null || row.titled_at === null) return { claimed: false, previous: null };
  const [result] = await commit(db, claimRefresh.bind(nowMs, projectId, sessionId, row.titled_at, refreshBefore));
  return { claimed: result.results.length === 1, previous: row.titled_at };
}


/**
 * Claims a titling attempt an owner asked for: any session, ended or not, titled or not. Refused while an attempt begun within `inFlightMs` may still be running, so two asks make one run. Stamps `titled_at`, and answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimOwnerTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, inFlightMs: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const [result] = await commit(db, claimOwner.bind(nowMs, projectId, sessionId, nowMs - inFlightMs));
  return { claimed: result.results.length === 1, previous: row.titled_at ?? null };
}


/** Puts back the stamp a claim replaced, for an attempt whose launch the runtime refused — the session keeps its own end-of-session attempt, and an owner may ask again at once. */
export async function restoreTitlingStamp(db: RelationalStore, projectId: string, sessionId: string, stamp: number, previous: number | null): Promise<void> {
  await commit(db, restore.bind(previous, projectId, sessionId, stamp));
}


/**
 * Records on the session's live document the user prompts the title just written covers. It runs right after the title
 * write in one batch and lands only when that write changed a row: the attribution between them is gated the same way.
 */
function titledUserPrompts(db: RelationalStore, projectId: string, sessionId: string): PreparedStatement {
  return prepareBound(db, titledPrompts.bind(projectId, sessionId));
}

/** Stores a session's title and summary over whatever is there, naming the member whose ask produced them; false when no such session sits in the project. */
export async function overwriteTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, titledBy: string | null, attribution?: RunWrite): Promise<boolean> {
  const statement = overwrite.bind(title, summary, titledBy, projectId, sessionId);
  const result = await commitAttributedWrite(db, { projectId }, statement, attribution, [titledUserPrompts(db, projectId, sessionId)]);
  return result.results.length > 0;
}


/** Stores a session's title and summary where none exists yet; false when one already does. */
export async function writeTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, attribution?: RunWrite): Promise<boolean> {
  const statement = writeFirst.bind(title, summary, projectId, sessionId);
  const result = await commitAttributedWrite(db, { projectId }, statement, attribution, [titledUserPrompts(db, projectId, sessionId)]);
  return result.results.length > 0;
}


