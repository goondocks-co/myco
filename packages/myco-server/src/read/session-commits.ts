/**
 * The commits a session stood on, as its member observed them at the session's
 * start, latest turn end and latest session end, and the release check that classified one of them.
 *
 * **A release state belongs to the observation it is classified from.** The
 * check records its source as `sourceOf` formats it; an observation carries the
 * state when its standing commit and cleanliness give that same evidence. A
 * state whose source names an observation replaced after the check, or that
 * recorded no source, is answered as such and attached to nothing. `basis_sha`
 * is never compared: a squash basis names the merge commit, not the observed
 * one.
 */
import type { RelationalStore } from '../core/adapters.js';
import { getReleaseState, sameReleaseEvidence, sourcePoint, type CapturePoint, type Cleanliness } from '../core/provenance.js';
import { readSessionObservations } from '../db/release/states.js';
import type { ReadScope } from './scope.js';

/** Whether tracked files differed from the commit: `unreadable` when the member could not tell. */
type CommitChanges = 'none' | 'uncommitted' | 'unreadable';

const CHANGES: Record<Cleanliness, CommitChanges> = { '0': 'none', '1': 'uncommitted', unknown: 'unreadable' };

interface CommitObservation {
  point: CapturePoint;
  /** The full commit; a reader shows it shortened. */
  headSha: string;
  branch: string | null;
  changes: CommitChanges;
  capturedAt: number;
}

interface CommitReleaseCheck {
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

interface SessionCommits {
  range: { visibility: 'not_visible'; reason: 'member_report_required' };
  /** Capture time order, with the session end after a turn end at the same instant. */
  observations: CommitObservation[];
  release: CommitReleaseCheck | null;
}

const POINT_ORDER: Record<CapturePoint, number> = { session_start: 0, turn_end: 1, session_end: 2 };

/** The session's commit observations and its release state. `idx_fk_knowledge_git_provenance_project_id_session_id` serves the read. */
export async function sessionCommits(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionCommits> {
  const rows = (await readSessionObservations(db, scope.projectId, sessionId)).sort((a, b) => a.capturedAt - b.capturedAt || POINT_ORDER[a.point] - POINT_ORDER[b.point]);
  const standing = rows.filter((row) => row.point !== 'session_start').at(-1) ?? rows.at(-1);
  const state = await getReleaseState(db, scope, 'session', sessionId);
  let release: CommitReleaseCheck | null = null;
  if (state !== null) {
    const matched = state.source !== null && standing !== undefined && sameReleaseEvidence(standing, state.source) ? standing : undefined;
    const point = matched?.point ?? (state.source === null ? null : sourcePoint(state.source));
    release = {
      state: state.state, basisKind: state.basisKind, basisRef: state.basisRef, releasePrNumber: state.releasePrNumber, checkedAt: state.checkedAt,
      covers: point === null ? null : { point, current: matched !== undefined },
    };
  }
  return {
    range: { visibility: 'not_visible', reason: 'member_report_required' },
    observations: rows.map((row) => ({ point: row.point, headSha: row.headSha, branch: row.branch === 'HEAD' ? null : row.branch, changes: CHANGES[row.cleanliness], capturedAt: row.capturedAt })),
    release,
  };
}
