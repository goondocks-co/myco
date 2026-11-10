import { canopyMapWrite } from '../db/runs/attributed-writes.js';
import { commitAttributedWrite } from '../db/runs/attribution.js';
import { type RunWrite } from '../db/runs/evidence.js';
import { CANOPY_DEFAULT_EXCLUDE_PATTERNS, MAP_TASK, parseMapArtifact, type MapSettings, type MapSourcePin, type StoredMap } from '@goondocks/myco-shared/canopy';
import type { RepositoryPin } from '@goondocks/myco-shared/repository';
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { readCanopyMap } from '../read/canopy.js';
import { capturedSinceMapPass } from '../db/canopy/map.js';
import { sha256Hex } from '../hash.js';
import { mapSourcePinOfRun, pinMapRepositoryForRun, pinMapSourceForRun, repositoryPinOfRun } from '../db/runs/preparation.js';
import { type RunLease } from '../db/runs/leases.js';
import { type RunRow } from '../db/runs/lifecycle.js';
import { settingTexts } from './settings.js';
import { repositoryIdentity } from './repositories.js';

const MAX_MAP_PIN_ATTEMPTS = 3;

export async function readMapSettings(db: RelationalStore): Promise<MapSettings> {
  const customLeaf = 'cortex.canopy.exclude.patterns';
  const raw = (await settingTexts(db, [customLeaf])).get(customLeaf);
  return { defaultPatterns: [...CANOPY_DEFAULT_EXCLUDE_PATTERNS], userPatterns: raw === undefined ? [] : JSON.parse(raw) as string[] };
}

/**
 * The hash a map's input carries: the committed source a pass reads and the
 * exclusions it reads under. Two passes over the same commit under the same
 * exclusions read the same input, and the second closes as unchanged.
 */
export async function mapInputHash(settings: MapSettings, repository: RepositoryPin): Promise<string> {
  return sha256Hex(JSON.stringify({ settings, repository: { url: repository.url, branch: repository.branch, commit: repository.commit } }));
}

/**
 * Pin a map run's input at the instant its commit is pinned: the hash of that
 * commit under the Deployment's exclusions, and the map revision the run
 * succeeds. Written once; a repeat answers the pin already held.
 */
export async function pinMapRepositoryAtCommit(db: RelationalStore, scope: ReadScope, run: RunRow, repository: RepositoryPin, lease: RunLease): Promise<RepositoryPin | null> {
  let candidate = repositoryPinOfRun(run) ?? repository;
  for (let attempt = 0; attempt < MAX_MAP_PIN_ATTEMPTS; attempt++) {
    const current = await readCanopyMap(db, scope);
    const inputHash = await mapInputHash(await readMapSettings(db), candidate);
    const result = await pinMapRepositoryForRun(db, scope, run, candidate, { inputHash, priorRevision: current?.revision ?? null }, lease);
    if (result === null) return null;
    if (result.committed) return candidate;
    const pinnedRepository = repositoryPinOfRun(result.row);
    if (pinnedRepository !== null && mapSourcePinOfRun(result.row) !== null) return pinnedRepository;
    if (pinnedRepository === null) return null;
    if (pinnedRepository.url === candidate.url && pinnedRepository.branch === candidate.branch && pinnedRepository.commit === candidate.commit) return null;
    candidate = pinnedRepository;
  }
  throw new Error('Map repository pin changed during preparation.');
}

/**
 * Whether live capture has moved beyond the Project's last settled map pass.
 * Captured work is what moves a repository, and a clock that finds none
 * spends no pass on it. A pass settles when a map run completes — with a map
 * written or the current one standing — and it covers all work captured before
 * the run started: the commit it read is pinned after its start. A stored map
 * with no completed run behind it counts from its generation.
 */
export async function capturedSinceMap(db: RelationalStore, scope: ReadScope): Promise<boolean> {
  return capturedSinceMapPass(db, scope.projectId, MAP_TASK);
}

/** Whether the current map already reflects the input this run pinned, so the run owes no new one. */
export function mapInputUnchanged(current: StoredMap | null, source: MapSourcePin | null): boolean {
  return current !== null && source !== null && current.inputHash === source.inputHash && current.revision === source.priorRevision;
}

/** Publish one map against the revision and committed source the held run prepared. */
export async function writeCanopyMap(db: RelationalStore, scope: ReadScope, run: RunRow, value: unknown, now: number, attribution?: RunWrite): Promise<boolean> {
  const source = mapSourcePinOfRun(run);
  const repository = repositoryPinOfRun(run);
  if (run.task !== MAP_TASK || run.status !== 'running' || run.dryRun === 1 || source === null || repository === null) return false;
  const artifact = parseMapArtifact(value);
  const prior = await readCanopyMap(db, scope);
  if (prior?.sourceRunId === run.id) return prior.inputHash === source.inputHash && JSON.stringify(prior.artifact) === JSON.stringify(artifact);
  const statement = canopyMapWrite
    .bind(scope.projectId, crypto.randomUUID(), JSON.stringify(artifact), source.inputHash, repository.url, repository.branch, repository.commit, run.id, now,
      scope.projectId, run.id, run.dispatchedBy, scope.projectId, repository.url, repository.branch,
      source.priorRevision, scope.projectId, source.priorRevision, source.priorRevision);
  const result = await commitAttributedWrite(db, scope, statement, attribution);
  return result.results.length === 1;
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
