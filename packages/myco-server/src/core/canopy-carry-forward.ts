import { MAP_TASK, MAP_UNCHANGED_ACTION, MapArtifactError, mapGrounding } from '@goondocks/myco-shared/canopy';
import { parseRepositoryChanges, type RepositoryComparison } from '@goondocks/myco-shared/repository';
import { commitMapCarry, scheduledMapPreparation } from '../db/canopy/carry-forward.js';
import { repositoryConnection } from '../db/storage/repository-connection.js';
import { runUpdateStatement } from '../db/runs/change.js';
import { mapSourcePinOfRun, repositoryPinOfRun } from '../db/runs/preparation.js';
import type { RunRow } from '../db/runs/lifecycle.js';
import type { RunLease } from '../db/runs/leases.js';
import { readCanopyMap } from '../read/canopy.js';
import type { ReadScope } from '../read/scope.js';
import { INPUT_UNCHANGED } from '../db/schedule-entry.js';
import { mapInputHash, readMapSettingsSnapshot } from './canopy.js';
import { settleAttemptCostStatement } from './attempt-accounting.js';
import { skipContext } from './runs.js';
import type { RelationalStore } from './adapters.js';

export const MAX_MAP_CONTENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Source preparation offers comparisons only for automatic, non-dry map attempts. */
async function carrySource(db: RelationalStore, scope: ReadScope, run: RunRow, now: number) {
  if (run.task !== MAP_TASK || await scheduledMapPreparation(db, scope.projectId, run.id) === null) return null;
  let map;
  try { map = await readCanopyMap(db, scope); }
  catch (error) { if (error instanceof MapArtifactError) return null; throw error; }
  if (map === null || now - map.generatedAt > MAX_MAP_CONTENT_AGE_MS || mapGrounding(map.artifact).length === 0) return null;
  const repository = await repositoryConnection(db, scope.projectId);
  const snapshot = await readMapSettingsSnapshot(db);
  if (repository === null || repository.url !== map.repository.url || repository.branch !== map.repository.branch
    || map.inputHash !== await mapInputHash(snapshot.settings, map.repository)) return null;
  const comparison: RepositoryComparison = { commit: map.repository.commit, revision: map.revision,
    repositoryRevision: repository.revision, settingsRevision: snapshot.revision };
  return { map, repository, snapshot, comparison };
}

export async function mapRepositoryComparison(db: RelationalStore, scope: ReadScope, run: RunRow, now: number): Promise<RepositoryComparison | null> {
  return (await carrySource(db, scope, run, now))?.comparison ?? null;
}

/** The Deployment judges complete runner evidence and settles a map without starting a harness. */
export async function carryMapForward(db: RelationalStore, options: {
  scope: ReadScope; run: RunRow & { dispatchedBy: string }; evidence: unknown; lease: RunLease;
}): Promise<boolean> {
  const { scope, run, lease } = options;
  const evidence = parseRepositoryChanges(options.evidence);
  if (evidence === null) return false;
  const source = await carrySource(db, scope, run, lease.now);
  const pin = repositoryPinOfRun(run);
  const input = mapSourcePinOfRun(run);
  if (source === null || pin === null || input === null || run.runContext === null) return false;
  const { map, repository, snapshot, comparison } = source;
  if (Object.keys(comparison).some(key => comparison[key as keyof RepositoryComparison] !== evidence[key as keyof RepositoryComparison])
    || input.priorRevision !== map.revision || pin.url !== repository.url || pin.branch !== repository.branch) return false;
  const grounded = new Set(mapGrounding(map.artifact).map(file => file.path));
  const skeleton = map.artifact.directories.map(directory => directory.path);
  const changesMap = evidence.changes.some(change => {
    if (skeleton.some(path => path === change.path || path.startsWith(change.path + '/'))) return true;
    if (change.status === 'D' || change.status === 'T' || grounded.has(change.path)) return true;
    return change.status === 'A' && !skeleton.some(path => change.path.startsWith(path + '/'));
  });
  if (changesMap) return false;

  const inputHash = await mapInputHash(snapshot.settings, pin);
  if (input.inputHash !== inputHash) return false;
  const revision = crypto.randomUUID();
  const context = skipContext(INPUT_UNCHANGED);
  const end = runUpdateStatement(scope, run.id, { status: 'skipped', completed_at: lease.now,
    run_context: context, error: null, tokens_used: 0, cost_usd: 0,
    actions_taken: JSON.stringify([{ action: MAP_UNCHANGED_ACTION, summary: 'the code map was already current',
      fromCommit: map.repository.commit, commit: pin.commit }]) },
  { lease: { ...lease, dispatchedBy: run.dispatchedBy } });
  if (end === null) return false;
  return commitMapCarry(db, { projectId: scope.projectId, runId: run.id, attemptId: run.dispatchedBy,
    context: run.runContext, priorRevision: map.revision, oldHash: map.inputHash, oldCommit: map.repository.commit,
    repositoryRevision: repository.revision, url: repository.url, branch: repository.branch,
    settingsGuard: snapshot.guard, revision, commit: pin.commit, inputHash, closedContext: context, now: lease.now, maxContentAgeMs: MAX_MAP_CONTENT_AGE_MS,
    settlement: settleAttemptCostStatement(scope, run.id, run.dispatchedBy, lease.worker, lease.now, 0, null), end });
}
