import { parseMapArtifact, renderMap, type StoredMap } from '@goondocks/myco-shared/canopy';
import type { RelationalStore } from '../core/adapters.js';
import { readCanopyMapRow } from '../db/canopy/map.js';
import type { ReadScope } from './scope.js';

/** The project's current map; markdown is rendered from its canonical artifact and source identity. */
export async function readCanopyMap(db: RelationalStore, scope: ReadScope): Promise<StoredMap | null> {
  const row = await readCanopyMapRow(db, scope.projectId);
  if (row === null) return null;
  const artifact = parseMapArtifact(JSON.parse(row.artifact));
  const repository = { url: row.url, branch: row.branch, commit: row.commitId };
  return { revision: row.revision, artifact, content: renderMap(artifact, repository), inputHash: row.inputHash,
    repository, sourceRunId: row.sourceRunId, generatedAt: row.generatedAt };
}
