import { parseMapArtifact, renderMap, type StoredMap } from '@goondocks/myco-shared/canopy';
import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

export type CanopyMapRow = StoredMap;

/** The project's current map; markdown is rendered from its canonical artifact and source identity. */
export async function readCanopyMap(db: RelationalStore, scope: ReadScope): Promise<CanopyMapRow | null> {
  const row = await db.prepare(`SELECT revision, artifact, input_hash AS inputHash, repository_url AS url,
    repository_branch AS branch, repository_commit AS commitId, source_run_id AS sourceRunId, generated_at AS generatedAt
    FROM canopy_maps WHERE project_id = ?`).bind(scope.projectId).first<{
      revision: string; artifact: string; inputHash: string; url: string; branch: string; commitId: string; sourceRunId: string; generatedAt: number;
    }>();
  if (row === null) return null;
  const artifact = parseMapArtifact(JSON.parse(row.artifact));
  const repository = { url: row.url, branch: row.branch, commit: row.commitId };
  return { revision: row.revision, artifact, content: renderMap(artifact, repository), inputHash: row.inputHash,
    repository, sourceRunId: row.sourceRunId, generatedAt: row.generatedAt };
}
