import type { PreparedStatement, RelationalStore, RunResult } from '../core/adapters.js';
import { occurredAt, presentedEndedAt, presentedStartedAt } from '../db/session-dates.js';
import { containsPattern, inListChunks, keyset, page, projectsFiltering, type Page, type ProjectSet, type ReadScope } from './scope.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { sourceTimestampsRecorded } from '@goondocks/myco-shared/capture-rules';
import { sessions_projectExists as projectExists, type sessions_ArchiveOutcome as ArchiveOutcome } from './catalog/sessions.js';
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
} from './catalog/sessions.js';
export { containsPattern } from './scope.js';



/** Archive a project: capture is refused from here on, listings hide it by default, and everything captured stays. One statement moves it; a read tells an absent project from one already archived. */
export async function archiveProject(db: RelationalStore, projectId: string, by: string, nowMs: number): Promise<ArchiveOutcome> {
  const result = await db
    .prepare(`UPDATE projects SET archived_at = ?, archived_by = ? WHERE project_id = ? AND archived_at IS NULL RETURNING project_id`)
    .bind(nowMs, by, projectId)
    .all();
  if (result.results.length === 1) return 'archived';
  return (await projectExists(db, projectId)) ? 'already_archived' : 'absent';
}


export { unarchiveProject, type UnarchiveOutcome } from '../db/storage/projects.js';

export { claimTitling, claimRefreshTitling, claimOwnerTitling, restoreTitlingStamp, overwriteTitle, writeTitle } from '../db/session-titles.js';

/** Give a project a new display name; `absent` when no row carries the id. Archived projects rename too: the name is display, not capture. */
export async function renameProject(db: RelationalStore, projectId: string, name: string): Promise<'renamed' | 'absent'> {
  const result = await db.prepare(`UPDATE projects SET name = ? WHERE project_id = ? RETURNING project_id`).bind(name, projectId).all();
  return result.results.length === 1 ? 'renamed' : 'absent';
}


export { createProject } from '../core/project-creation.js';
