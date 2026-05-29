import { epochSeconds } from '@myco/constants.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import {
  buildGitProvenanceIdentityKey,
  gitProvenanceExists,
  insertGitProvenance,
  type GitProvenanceRow,
  type ReleaseCapturePoint,
} from '@myco/db/queries/release-provenance.js';
import { PROMPT_BATCH_ORIGIN, type PromptBatchOrigin } from '@myco/db/queries/batches.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { captureGitSnapshot, type GitSnapshot } from './git-snapshot.js';

export interface CaptureGitProvenanceInput {
  projectRoot: string;
  projectId?: string | null;
  machineId?: string;
  sessionId?: string | null;
  promptBatchId?: number | null;
  capturePoint: ReleaseCapturePoint;
  capturedAt?: number;
  productionRef?: string | null;
  /**
   * Provenance is a user-intent signal: it stamps the code state at the
   * moment the user made a decision. Synthesized envelopes (system reminders,
   * teammate messages, task notifications, …) are not user decisions; the
   * capture is a no-op for any non-`'human'` origin. Omit to default to
   * `'human'` for callers that have already filtered upstream.
   */
  promptOrigin?: PromptBatchOrigin;
  logger?: Pick<DaemonLogger, 'debug' | 'warn'>;
  snapshotProvider?: (projectRoot: string, options: { productionRef?: string | null }) => GitSnapshot;
}

/**
 * Schedule a Git provenance capture off the current event-loop tick so request
 * handlers don't pay the cost (15+ blocking git commands per call) on the hot
 * path. `onCaptured` runs after capture with the resulting row (or null on
 * failure) so callers can backfill derived fields like `session.branch`.
 *
 * Capture remains synchronous internally — this only shifts when it runs.
 * Errors are already swallowed inside captureGitProvenance, so a failed
 * setImmediate body cannot leak into request handling.
 */
export function deferGitProvenance(
  input: CaptureGitProvenanceInput,
  onCaptured?: (row: GitProvenanceRow | null) => void,
): void {
  if ((input.promptOrigin ?? PROMPT_BATCH_ORIGIN.HUMAN) !== PROMPT_BATCH_ORIGIN.HUMAN) {
    onCaptured?.(null);
    return;
  }
  setImmediate(() => {
    const row = captureGitProvenance(input);
    if (onCaptured) {
      try {
        onCaptured(row);
      } catch (err) {
        input.logger?.warn(LOG_KINDS.CAPTURE_RELEASE_PROVENANCE, 'Deferred provenance callback failed', {
          session_id: input.sessionId ?? null,
          error: (err as Error).message,
        });
      }
    }
  });
}

export function captureGitProvenance(input: CaptureGitProvenanceInput): GitProvenanceRow | null {
  if ((input.promptOrigin ?? PROMPT_BATCH_ORIGIN.HUMAN) !== PROMPT_BATCH_ORIGIN.HUMAN) return null;
  const capturedAt = input.capturedAt ?? epochSeconds();
  const snapshotProvider = input.snapshotProvider ?? captureGitSnapshot;

  try {
    const snapshot = snapshotProvider(input.projectRoot, { productionRef: input.productionRef });
    // Repeated hook deliveries at the same boundary (e.g., retried Stop events)
    // would otherwise rewrite identical rows and churn the team outbox. Skip
    // the write when the identity key already exists for this status hash.
    const identityKey = buildGitProvenanceIdentityKey({
      project_id: input.projectId ?? null,
      session_id: input.sessionId ?? null,
      prompt_batch_id: input.promptBatchId ?? null,
      capture_point: input.capturePoint,
      status_hash: snapshot.status_hash,
    });
    if (gitProvenanceExists(identityKey)) {
      input.logger?.debug(LOG_KINDS.CAPTURE_RELEASE_PROVENANCE, 'Git provenance unchanged; skip write', {
        session_id: input.sessionId ?? null,
        prompt_batch_id: input.promptBatchId ?? null,
        capture_point: input.capturePoint,
        status_hash: snapshot.status_hash,
      });
      return null;
    }
    const row = insertGitProvenance({
      project_id: input.projectId ?? null,
      machine_id: input.machineId ?? 'local',
      session_id: input.sessionId ?? null,
      prompt_batch_id: input.promptBatchId ?? null,
      capture_point: input.capturePoint,
      captured_at: capturedAt,
      project_root: snapshot.project_root,
      branch: snapshot.branch,
      head_sha: snapshot.head_sha,
      upstream_ref: snapshot.upstream_ref,
      upstream_sha: snapshot.upstream_sha,
      production_ref: snapshot.production_ref,
      production_sha: snapshot.production_sha,
      is_dirty: snapshot.is_dirty,
      staged_count: snapshot.staged_count,
      unstaged_count: snapshot.unstaged_count,
      untracked_count: snapshot.untracked_count,
      changed_paths_json: JSON.stringify(snapshot.changed_paths),
      tracked_blob_hashes_json: JSON.stringify(snapshot.tracked_blob_hashes),
      patch_ids_json: JSON.stringify(snapshot.patch_ids),
      status_hash: snapshot.status_hash,
      evidence_json: JSON.stringify(snapshot.evidence),
      error: snapshot.error,
      created_at: capturedAt,
    });
    input.logger?.debug(LOG_KINDS.CAPTURE_RELEASE_PROVENANCE, 'Git provenance captured', {
      session_id: input.sessionId ?? null,
      prompt_batch_id: input.promptBatchId ?? null,
      capture_point: input.capturePoint,
      status_hash: snapshot.status_hash,
      error: snapshot.error,
    });
    return row;
  } catch (err) {
    input.logger?.warn(LOG_KINDS.CAPTURE_RELEASE_PROVENANCE, 'Git provenance capture failed', {
      session_id: input.sessionId ?? null,
      prompt_batch_id: input.promptBatchId ?? null,
      capture_point: input.capturePoint,
      error: (err as Error).message,
    });
    return null;
  }
}
