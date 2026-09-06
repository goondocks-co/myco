import { CANOPY_DEFAULT_EXCLUDE_PATTERNS, MAP_TASK, parseMapArtifact, type MapSettings } from '@goondocks/myco-shared/canopy';
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { readCanopyMap } from '../read/canopy.js';
import { mapSourcePinOfRun, repositoryPinOfRun, type RunRow } from './runs.js';
import { leafValues } from './settings.js';
import { repositoryIdentity } from './repositories.js';

export async function readMapSettings(db: RelationalStore): Promise<MapSettings> {
  const customLeaf = 'cortex.canopy.exclude.patterns';
  const leaves = await leafValues(db, [customLeaf]);
  const raw = leaves.get(customLeaf);
  const custom: unknown = raw === undefined ? [] : JSON.parse(raw);
  if (!Array.isArray(custom) || !custom.every((pattern) => typeof pattern === 'string')) throw new Error('Canopy exclusion patterns must be an array of strings.');
  return { defaultPatterns: [...CANOPY_DEFAULT_EXCLUDE_PATTERNS], userPatterns: custom };
}

/** Publish one map against the revision and committed source the held run prepared. */
export async function writeCanopyMap(db: RelationalStore, scope: ReadScope, run: RunRow, value: unknown, now: number): Promise<boolean> {
  const source = mapSourcePinOfRun(run);
  const repository = repositoryPinOfRun(run);
  if (run.task !== MAP_TASK || run.status !== 'running' || run.dryRun === 1 || source === null || repository === null) return false;
  const artifact = parseMapArtifact(value);
  const prior = await readCanopyMap(db, scope);
  if (prior?.sourceRunId === run.id) return prior.inputHash === source.inputHash && JSON.stringify(prior.artifact) === JSON.stringify(artifact);
  const result = await db.prepare(`INSERT INTO canopy_maps
    (project_id, revision, artifact, input_hash, repository_url, repository_branch, repository_commit, source_run_id, generated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND status = 'running' AND dispatched_by = ?)
      AND EXISTS (SELECT 1 FROM project_repositories WHERE project_id = ? AND url = ? AND branch = ?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM canopy_maps WHERE project_id = ? AND revision = ?))
    ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, artifact = excluded.artifact,
      input_hash = excluded.input_hash, repository_url = excluded.repository_url, repository_branch = excluded.repository_branch,
      repository_commit = excluded.repository_commit, source_run_id = excluded.source_run_id, generated_at = excluded.generated_at
    WHERE canopy_maps.revision = ?`)
    .bind(scope.projectId, crypto.randomUUID(), JSON.stringify(artifact), source.inputHash, repository.url, repository.branch, repository.commit, run.id, now,
      scope.projectId, run.id, run.dispatchedBy, scope.projectId, repository.url, repository.branch,
      source.priorRevision, scope.projectId, source.priorRevision, source.priorRevision).run();
  return result.meta.changes === 1;
}

/** A run owes a stored map or a verified no-change pass over the same admitted source. */
export async function canopyMapWrittenBy(db: RelationalStore, scope: ReadScope, run: RunRow): Promise<boolean> {
  const current = await readCanopyMap(db, scope);
  const source = mapSourcePinOfRun(run);
  const repository = repositoryPinOfRun(run);
  const connected = await repositoryIdentity(db, scope);
  return connected !== null && current !== null && source !== null && repository !== null && current.inputHash === source.inputHash
    && connected.url === repository.url && connected.branch === repository.branch
    && current.repository.url === repository.url && current.repository.branch === repository.branch
    && (current.sourceRunId === run.id || current.revision === source.priorRevision);
}
