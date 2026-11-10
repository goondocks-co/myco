import type { RelationalStore } from '../../core/adapters.js';
import { first, read } from '../index.js';

/** A Project's one stored map, as its row holds it: the artifact as JSON text and the source it was read from. */
export interface CanopyMapRow {
  revision: string; artifact: string; inputHash: string; url: string; branch: string; commitId: string; sourceRunId: string; generatedAt: number;
}

const MAP = read<[project: string], CanopyMapRow>({ name: 'canopyMap.get',
  sql: `SELECT revision, artifact, input_hash AS inputHash, repository_url AS url, repository_branch AS branch, repository_commit AS commitId,
    source_run_id AS sourceRunId, generated_at AS generatedAt FROM canopy_maps WHERE project_id=?1` });

/** The Project's stored map row, or null when it has none. One primary-key read of a bounded artifact. */
export const readCanopyMapRow = (db: RelationalStore, projectId: string): Promise<CanopyMapRow | null> => first(db, MAP.bind(projectId));

/**
 * Whether any live session of the Project received capture after its last settled map pass: the latest start of a
 * completed, non-dry map run, or the stored map's generation when no such run stands behind it.
 */
const CAPTURED_SINCE = read<[project: string, task: string], { one: number }>({ name: 'canopyMap.capturedSince',
  sql: `SELECT 1 AS one FROM session_read_facts INDEXED BY idx_session_read_activity
    WHERE project_id=?1 AND has_session=1 AND tombstoned=0 AND last_received_at > MAX(
      COALESCE((SELECT MAX(started_at) FROM agent_runs WHERE project_id=?1 AND task=?2 AND status='completed' AND dry_run=0), -1),
      COALESCE((SELECT generated_at FROM canopy_maps WHERE project_id=?1), -1)) LIMIT 1` });

export async function capturedSinceMapPass(db: RelationalStore, projectId: string, mapTask: string): Promise<boolean> {
  return (await first(db, CAPTURED_SINCE.bind(projectId, mapTask))) !== null;
}
