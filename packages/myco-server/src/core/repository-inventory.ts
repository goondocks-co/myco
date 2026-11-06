import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { repositoryFiles, RepositoryInputError } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import { repositoryPinOfRun, type RunLease, type RunRow } from './runs.js';
import { renewingLeaseAuthority } from './worker-lease.js';

/** The held map checkout publishes its complete committed inventory once, before model execution. */
export async function storeRepositoryInventory(db: RelationalStore, projectId: string, run: RunRow, input: Record<string, unknown>, lease: RunLease): Promise<boolean> {
  const pin = repositoryPinOfRun(run);
  if (run.task !== MAP_TASK || pin === null || run.dispatchedBy === null
    || pin.url !== input.url || pin.branch !== input.branch || pin.commit !== input.commit) {
    throw new RepositoryInputError('Repository inventory must match the map run’s pinned commit.');
  }
  const files = JSON.stringify(repositoryFiles(input.files));
  const authority = renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy, true);
  const result = await db.prepare(`UPDATE agent_runs SET repository_files=? WHERE project_id=? AND id=? AND ${authority.sql}
    AND (repository_files IS NULL OR repository_files=?)
    AND json_extract(run_context,'$.repository.commit')=?
    AND EXISTS (SELECT 1 FROM project_repositories WHERE project_id=? AND url=? AND branch=?)`)
    .bind(files,projectId,run.id,...authority.params,files,pin.commit,projectId,pin.url,pin.branch).run();
  return result.meta.changes === 1;
}

export interface RepositoryInventory { commit: string; generatedAt: number; files: string[] }

/** A map's inventory is evidence only for the connected repository and the exact commit it describes. */
export async function readRepositoryInventory(db: RelationalStore, projectId: string): Promise<RepositoryInventory | null> {
  const row = await db.prepare(`SELECT m.repository_commit AS commitId,r.repository_files AS files,m.generated_at AS generatedAt
    FROM canopy_maps m JOIN project_repositories p ON p.project_id=m.project_id AND p.url=m.repository_url AND p.branch=m.repository_branch
    JOIN agent_runs r ON r.project_id=m.project_id AND r.id=m.source_run_id
    WHERE m.project_id=? AND r.repository_files IS NOT NULL
      AND json_extract(r.run_context,'$.repository.url')=m.repository_url
      AND json_extract(r.run_context,'$.repository.branch')=m.repository_branch
      AND json_extract(r.run_context,'$.repository.commit')=m.repository_commit`).bind(projectId).first<{commitId:string;files:string;generatedAt:number}>();
  return row === null ? null : { commit: row.commitId, generatedAt:row.generatedAt, files:repositoryFiles(JSON.parse(row.files)) };
}
