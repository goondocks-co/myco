/**
 * The commits a session stood on, as its member observed them at the session's
 * start and end, and the release check that classified one of them.
 *
 * **Only the two endpoints are stored.** `sessionCommit` keeps at most one
 * `session_start` and one `session_end` row per session, so this read never
 * answers whether HEAD moved between them or what came in between.
 *
 * **A release state belongs to the observation it is classified from.** The
 * check records its source as `sourceOf` formats it; an observation carries the
 * state only when its point, commit and cleanliness give that same source. A
 * state whose source names an observation replaced after the check, or that
 * recorded no source, is answered as such and attached to nothing. `basis_sha`
 * is never compared: a squash basis names the merge commit, not the observed
 * one.
 */
import type { RelationalStore } from '../core/adapters.js';
import { CLEANLINESS_SQL, getReleaseState, sourceOf, sourcePoint, type CapturePoint, type Cleanliness } from '../core/provenance.js';
import type { ReadScope } from './scope.js';

/** Whether tracked files differed from the commit: `unreadable` when the member could not tell. */
export type CommitChanges = 'none' | 'uncommitted' | 'unreadable';

const CHANGES: Record<Cleanliness, CommitChanges> = { '0': 'none', '1': 'uncommitted', unknown: 'unreadable' };

export interface CommitObservation {
  point: CapturePoint;
  /** The full commit; a reader shows it shortened. */
  headSha: string;
  branch: string | null;
  changes: CommitChanges;
  capturedAt: number;
}

export interface CommitReleaseCheck {
  state: string;
  basisKind: string | null;
  basisRef: string | null;
  releasePrNumber: number | null;
  checkedAt: number;
  /**
   * The observation the check classified: `current` when the observation at `point` still gives the recorded
   * source, false when it changed after the check. Null when the state recorded no source.
   */
  covers: { point: CapturePoint; current: boolean } | null;
}

export interface SessionCommits {
  /** Start first, then end. */
  observations: CommitObservation[];
  release: CommitReleaseCheck | null;
}

const POINT_ORDER: Record<CapturePoint, number> = { session_start: 0, session_end: 1 };

/** The session's commit observations and its release state. `idx_fk_knowledge_git_provenance_project_id_session_id` serves the read. */
export async function sessionCommits(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionCommits> {
  const { results } = await db.prepare(`SELECT g.capture_point AS point, g.head_sha AS headSha, g.branch, g.captured_at AS capturedAt,
      ${CLEANLINESS_SQL} AS cleanliness
    FROM knowledge_git_provenance g
    WHERE g.project_id = ? AND g.session_id = ? AND g.capture_point IN ('session_start', 'session_end') AND g.head_sha IS NOT NULL`)
    .bind(scope.projectId, sessionId)
    .all<{ point: CapturePoint; headSha: string; branch: string | null; capturedAt: number; cleanliness: Cleanliness }>();
  const rows = [...results].sort((a, b) => POINT_ORDER[a.point] - POINT_ORDER[b.point]);
  const state = await getReleaseState(db, scope, 'session', sessionId);
  let release: CommitReleaseCheck | null = null;
  if (state !== null) {
    const matched = state.source === null ? undefined : rows.find((row) => sourceOf(row) === state.source);
    const point = matched?.point ?? (state.source === null ? null : sourcePoint(state.source));
    release = {
      state: state.state, basisKind: state.basisKind, basisRef: state.basisRef, releasePrNumber: state.releasePrNumber, checkedAt: state.checkedAt,
      covers: point === null ? null : { point, current: matched !== undefined },
    };
  }
  return {
    observations: rows.map((row) => ({ point: row.point, headSha: row.headSha, branch: row.branch, changes: CHANGES[row.cleanliness], capturedAt: row.capturedAt })),
    release,
  };
}
