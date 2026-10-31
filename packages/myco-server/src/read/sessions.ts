import { commitAttributedWrite, titleRunInFlightSql, type RunWrite } from '../core/runs.js';
import type { PreparedStatement, RelationalStore, RunResult } from '../core/adapters.js';
import { occurredAt, presentedEndedAt, presentedStartedAt } from '../db/session-dates.js';
import { containsPattern, inListChunks, keyset, page, projectsFiltering, type Page, type ProjectSet, type ReadScope } from './scope.js';
import { notTombstonedSql, NOT_TOMBSTONED_PARAMS } from '../core/tombstones.js';
import { sessionMaterialReadySql, titlingClaimAvailableSql } from './material-readiness.js';
import { SQL_NOW_MS } from '../core/run-deadline.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { sourceTimestampsRecorded } from '@goondocks/myco-shared/capture-rules';
import { sessions_projectExists as projectExists, type sessions_ArchiveOutcome as ArchiveOutcome, type sessions_UnarchiveOutcome as UnarchiveOutcome } from './view-store.js';
export {
  type sessions_ProjectRow as ProjectRow,
  type sessions_SessionRow as SessionRow,
  type sessions_ProjectStats as ProjectStats,
  type sessions_SessionCounts as SessionCounts,
  sessions_FIRST_PROMPT_CHARS as FIRST_PROMPT_CHARS,
  sessions_LABEL_MAX_CHARS as LABEL_MAX_CHARS,
  sessions_UNTITLED_SESSION_LABEL as UNTITLED_SESSION_LABEL,
  sessions_sessionLabel as sessionLabel,
  sessions_relatedSessionLabel as relatedSessionLabel,
  sessions_PRESENTED_STARTED_AT as PRESENTED_STARTED_AT,
  sessions_PRESENTED_ENDED_AT as PRESENTED_ENDED_AT,
  sessions_SESSIONS_ACROSS_INDEX as SESSIONS_ACROSS_INDEX,
  sessions_SESSIONS_ACTIVE_INDEX as SESSIONS_ACTIVE_INDEX,
  sessions_SESSIONS_WORKING_INDEX as SESSIONS_WORKING_INDEX,
  sessions_WORKING_CAP_MS as WORKING_CAP_MS,
  sessions_listProjectsSql as listProjectsSql,
  sessions_listProjects as listProjects,
  type sessions_ArchiveOutcome as ArchiveOutcome,
  type sessions_UnarchiveOutcome as UnarchiveOutcome,
  type sessions_SessionFilters as SessionFilters,
  sessions_SESSION_OCCURRED_AT as SESSION_OCCURRED_AT,
  sessions_listSessions as listSessions,
  sessions_listSessionsAcross as listSessionsAcross,
  sessions_getSession as getSession,
  sessions_sessionDurationMs as sessionDurationMs,
  type sessions_SessionLifecycle as SessionLifecycle,
  sessions_sessionLifecycle as sessionLifecycle,
  sessions_sessionCounts as sessionCounts,
  sessions_sessionCountsFor as sessionCountsFor,
  type sessions_SessionSummaryRow as SessionSummaryRow,
  sessions_listSessionSummaries as listSessionSummaries,
  type sessions_SessionAcrossRow as SessionAcrossRow,
  sessions_listSessionSummariesAcross as listSessionSummariesAcross,
  sessions_projectStats as projectStats,
  sessions_projectExists as projectExists,
  sessions_existingProjects as existingProjects,
  sessions_sessionInScope as sessionInScope,
  sessions_sessionHeldByMachine as sessionHeldByMachine,
  sessions_projectHoldsSession as projectHoldsSession,
  sessions_sessionCarriesTitle as sessionCarriesTitle,
  sessions_heldSessionIds as heldSessionIds,
  sessions_sessionsOwnedByImporter as sessionsOwnedByImporter,
  sessions_sessionsWithImportedPrompts as sessionsWithImportedPrompts,
} from './view-store.js';
export { containsPattern } from './scope.js';



/** Archive a project: capture is refused from here on, listings hide it by default, and everything captured stays. One statement moves it; a read tells an absent project from one already archived. */
export async function archiveProject(db: RelationalStore, projectId: string, by: string, nowMs: number): Promise<ArchiveOutcome> {
  const result = await db
    .prepare(`UPDATE projects SET archived_at = ?, archived_by = ? WHERE project_id = ? AND archived_at IS NULL`)
    .bind(nowMs, by, projectId)
    .run();
  if (result.meta.changes === 1) return 'archived';
  return (await projectExists(db, projectId)) ? 'already_archived' : 'absent';
}


/** Restore capture for an archived project. */
export async function unarchiveProject(db: RelationalStore, projectId: string): Promise<UnarchiveOutcome> {
  const result = await db
    .prepare(`UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE project_id = ? AND archived_at IS NOT NULL`)
    .bind(projectId)
    .run();
  if (result.meta.changes === 1) return 'restored';
  return (await projectExists(db, projectId)) ? 'not_archived' : 'absent';
}


/** The session's titling stamp as it stands, or null when the project holds no such session. */
const titlingStamp = (db: RelationalStore, projectId: string, sessionId: string) =>
  db.prepare(`SELECT titled_at FROM sessions WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ titled_at: number | null }>();


/**
 * Claims the first automatic attempt on a session that has ended or, given `idleBefore`, gone quiet (its last receipt at or before
 * that instant), or, given `retryBefore`, a retry of one that ended untitled with its stamp before that instant; null admits a
 * first attempt only. Answers the stamp it replaced, so an attempt that never launches can put exactly that back.
 */
export async function claimTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, retryBefore: number | null, idleBefore: number | null = null): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const previous = row.titled_at ?? null;
  const result = await db
    .prepare(`UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at IS ? AND (ended_at IS NOT NULL OR last_received_at <= ?) AND ${titlingClaimAvailableSql('sessions')} AND ${sessionMaterialReadySql('sessions')}`)
    .bind(nowMs, projectId, sessionId, previous, idleBefore ?? 0, retryBefore)
    .run();
  return { claimed: result.meta.changes === 1, previous };
}


/**
 * Claims the refresh of a titled session, open or ended: its title stamped at or before `refreshBefore`, a later receipt, and no
 * title run of it in flight. Stamps `titled_at`, which holds the next refresh off for the interval and leaves `title_material_at`,
 * the material of the standing title, where it is; answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimRefreshTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, refreshBefore: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null || row.titled_at === null) return { claimed: false, previous: null };
  const result = await db
    .prepare(`UPDATE sessions SET titled_at = ?, title_material_at = COALESCE(title_material_at, titled_at) WHERE project_id = ? AND session_id = ? AND titled_at = ? AND titled_at <= ? AND title IS NOT NULL AND last_received_at > COALESCE(title_material_at, titled_at)
      AND NOT ${titleRunInFlightSql('sessions')} AND ${sessionMaterialReadySql('sessions')}`)
    .bind(nowMs, projectId, sessionId, row.titled_at, refreshBefore)
    .run();
  return { claimed: result.meta.changes === 1, previous: row.titled_at };
}


/**
 * Claims a titling attempt an owner asked for: any session, ended or not, titled or not. Refused while an attempt begun within `inFlightMs` may still be running, so two asks make one run. Stamps `titled_at`, and answers the stamp it replaced so an attempt that never launches can put it back.
 */
export async function claimOwnerTitling(db: RelationalStore, projectId: string, sessionId: string, nowMs: number, inFlightMs: number): Promise<{ claimed: boolean; previous: number | null }> {
  const row = await titlingStamp(db, projectId, sessionId);
  if (row === null) return { claimed: false, previous: null };
  const result = await db
    .prepare(`UPDATE sessions SET titled_at = ?, title_material_at = CASE WHEN title IS NULL THEN title_material_at ELSE COALESCE(title_material_at, titled_at) END WHERE project_id = ? AND session_id = ? AND (titled_at IS NULL OR titled_at < ?) AND ${sessionMaterialReadySql('sessions')}`)
    .bind(nowMs, projectId, sessionId, nowMs - inFlightMs)
    .run();
  return { claimed: result.meta.changes === 1, previous: row.titled_at ?? null };
}


/** Puts back the stamp a claim replaced, for an attempt whose launch the runtime refused — the session keeps its own end-of-session attempt, and an owner may ask again at once. */
export async function restoreTitlingStamp(db: RelationalStore, projectId: string, sessionId: string, stamp: number, previous: number | null): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND titled_at = ?`)
    .bind(previous, projectId, sessionId, stamp)
    .run();
}


/** The user prompts the session's live document holds, which a title records as the material it covers. */
const TITLE_USER_PROMPTS = `(SELECT d.user_prompts FROM session_documents d WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id AND d.state = 'live')`;

/** Stores a session's title and summary over whatever is there, naming the member whose ask produced them; false when no such session sits in the project. */
export async function overwriteTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, titledBy: string | null, attribution?: RunWrite): Promise<boolean> {
  const statement = db
    .prepare(`UPDATE sessions SET title = ?, summary = ?, titled_by = ?, title_material_at = COALESCE(titled_at, ${SQL_NOW_MS}), title_user_prompts = ${TITLE_USER_PROMPTS} WHERE project_id = ? AND session_id = ? AND ${notTombstonedSql('sessions')} AND ${sessionMaterialReadySql('sessions')}`)
    .bind(title, summary, titledBy, projectId, sessionId);
  const result = await commitAttributedWrite(db, { projectId }, statement, attribution);
  return result.meta.changes > 0;
}


/** Stores a session's title and summary where none exists yet; false when one already does. */
export async function writeTitle(db: RelationalStore, projectId: string, sessionId: string, title: string, summary: string, attribution?: RunWrite): Promise<boolean> {
  const statement = db
    .prepare(`UPDATE sessions SET title = ?, summary = ?, title_material_at = COALESCE(titled_at, ${SQL_NOW_MS}), title_user_prompts = ${TITLE_USER_PROMPTS} WHERE project_id = ? AND session_id = ? AND title IS NULL AND ${notTombstonedSql('sessions')} AND ${sessionMaterialReadySql('sessions')}`)
    .bind(title, summary, projectId, sessionId);
  const result = await commitAttributedWrite(db, { projectId }, statement, attribution);
  return result.meta.changes > 0;
}


/** Give a project a new display name; `absent` when no row carries the id. Archived projects rename too: the name is display, not capture. */
export async function renameProject(db: RelationalStore, projectId: string, name: string): Promise<'renamed' | 'absent'> {
  const result = await db.prepare(`UPDATE projects SET name = ? WHERE project_id = ?`).bind(name, projectId).run();
  return result.meta.changes === 1 ? 'renamed' : 'absent';
}


/** Insert a project, answering false when one already carries the id. */
export async function createProject(db: RelationalStore, projectId: string, name: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`)
    .bind(projectId, name, nowMs)
    .run();
  return result.meta.changes === 1;
}
