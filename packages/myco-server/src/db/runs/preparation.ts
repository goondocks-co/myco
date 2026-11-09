import { REPOSITORY_COMMIT_PATTERN, parseRepositoryCheckoutSpec, KNOWLEDGE_REPOSITORY_TASKS, knowledgeOnlyInstruction, type RepositoryCheckoutSpec, type RepositoryPin, type RepositoryFailure } from '@goondocks/myco-shared/repository';
import { parseMapSourcePin, type MapSourcePin } from '@goondocks/myco-shared/canopy';
import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { renewingLeaseAuthority } from '../runners/lease-authority.js';
import { commit, first, read, readSet, write, type BindValue, type Statement } from '../index.js';
import { leaseShape, shapedStatements } from './statement-shapes.js';
import { knowledgeUnavailable } from './attributed-writes.js';
import { commitAttributedWrite } from './attribution.js';
import { MUTATE_ATTEMPTS } from './state.js';
import { getRun, type RunRow } from './lifecycle.js';
import { workerRunLeaseExpiry, type RunLease } from './leases.js';

const instructionRead = read<[project: string, run: string], { instruction: string | null }>({ name: 'runs.instructionRead', sql:
  `SELECT instruction FROM agent_runs WHERE project_id = ?1 AND id = ?2` });

function preparationOfRun(run: Pick<RunRow, 'runContext'>, key: 'repository' | 'canopy' | 'checkout'): unknown {
  if (run.runContext === null) return undefined;
  const context: unknown = JSON.parse(run.runContext);
  if (context === null || typeof context !== 'object' || Array.isArray(context)) throw new Error('Run context is not an object.');
  return (context as Record<string, unknown>)[key];
}

/** Source identity and history bound recorded with the claim's prompt. */
export function repositoryCheckoutOfRun(run: Pick<RunRow, 'runContext'>): RepositoryCheckoutSpec | null {
  const checkout = preparationOfRun(run, 'checkout');
  return checkout === undefined ? null : parseRepositoryCheckoutSpec(checkout);
}

/** The immutable source revision attached to a code run, if preparation has pinned it. */
export function repositoryPinOfRun(run: Pick<RunRow, 'runContext'>): RepositoryPin | null {
  const pin = preparationOfRun(run, 'repository');
  if (pin === undefined) return null;
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('Run repository pin is invalid.');
  const record = pin as RepositoryPin;
  if (typeof record.url !== 'string' || typeof record.branch !== 'string' || typeof record.commit !== 'string'
    || !REPOSITORY_COMMIT_PATTERN.test(record.commit)) throw new Error('Run repository pin is invalid.');
  return { url: record.url, branch: record.branch, commit: record.commit };
}

/** Pin once while the dispatched run is held; a repeat reads the first committed identity. */
export async function pinRepositoryForRun(db: RelationalStore, scope: ReadScope, run: RunRow, pin: RepositoryPin, lease?: RunLease): Promise<RepositoryPin | null> {
  repositoryPinOfRun(run);
  const result = await pinRunPreparation(db, scope, run, 'repository', pin, lease);
  return result === null ? null : result.committed ? pin : repositoryPinOfRun(result.row);
}

const mapRepositoryPin = shapedStatements<Statement<BindValue[], { id: string }, 'write'>>();
const preparationPin = shapedStatements<Statement<BindValue[], { id: string }, 'write'>>();
const knowledgeCheckoutHeld = shapedStatements<Statement<BindValue[], { checkout: string | null; instruction: string | null }, 'read'>>();

/** Pin a map run's repository and source input in one guarded write. */
export async function pinMapRepositoryForRun(
  db: RelationalStore, scope: ReadScope, run: RunRow, repository: RepositoryPin, source: MapSourcePin, lease: RunLease,
): Promise<{ committed: true } | { committed: false; row: RunRow } | null> {
  if (run.dispatchedBy === null) return null;
  const authority = renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy, true);
  const pin = mapRepositoryPin(leaseShape(lease.worker, run.dispatchedBy), shape => write<BindValue[], { id: string }>({ name: `runs.pinMapRepository${shape}`, sql: `UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'),
      '$.repository', json(?), '$.canopy', json(?))
    WHERE project_id = ? AND id = ? AND ${authority.sql}
      AND json_type(COALESCE(run_context, '{}'), '$.canopy') IS NULL
      AND (json_type(COALESCE(run_context, '{}'), '$.repository') IS NULL
        OR (json_extract(run_context, '$.repository.url') = ?
          AND json_extract(run_context, '$.repository.branch') = ?
          AND json_extract(run_context, '$.repository.commit') = ?)) RETURNING id` }));
  const [pinned] = await commit(db, pin.bind(JSON.stringify(repository), JSON.stringify(source), scope.projectId, run.id, ...authority.params as BindValue[],
    repository.url, repository.branch, repository.commit));
  if (pinned.results.length === 1) return { committed: true };
  if (await workerRunLeaseExpiry(db, scope, run.id, lease.worker, lease.now, run.dispatchedBy) === null) return null;
  const fresh = await getRun(db, scope, run.id);
  if (fresh === null || fresh.status !== 'running' || fresh.dispatchedBy !== run.dispatchedBy) return null;
  return { committed: false, row: fresh };
}

/** The source hash and map revision a run prepared before model execution. */
export function mapSourcePinOfRun(run: Pick<RunRow, 'runContext'>): MapSourcePin | null {
  const value = preparationOfRun(run, 'canopy');
  if (value === undefined) return null;
  return parseMapSourcePin(value);
}

export async function pinMapSourceForRun(db: RelationalStore, scope: ReadScope, run: RunRow, pin: MapSourcePin, lease?: RunLease): Promise<MapSourcePin | null> {
  mapSourcePinOfRun(run);
  const result = await pinRunPreparation(db, scope, run, 'canopy', parseMapSourcePin(pin), lease);
  return result === null ? null : result.committed ? pin : mapSourcePinOfRun(result.row);
}

/** Each preparation value is written once under the held run's guard; repeats read the first pin. */
async function pinRunPreparation(db: RelationalStore, scope: ReadScope, run: RunRow, key: 'repository' | 'canopy', value: RepositoryPin | MapSourcePin, lease?: RunLease): Promise<{ committed: true } | { committed: false; row: RunRow } | null> {
  const path = `$.${key}`;
  const authority = lease === undefined
    ? { sql: "status = 'running' AND dispatched_by = ?", params: [run.dispatchedBy] }
    : renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy ?? undefined, true);
  const pin = preparationPin(lease === undefined ? 'Held' : leaseShape(lease.worker, run.dispatchedBy ?? undefined), shape => write<BindValue[], { id: string }>({ name: `runs.pinPreparation${shape}`, sql: `UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'), ?, json(?))
    WHERE project_id = ? AND id = ? AND ${authority.sql}
      AND json_type(COALESCE(run_context, '{}'), ?) IS NULL RETURNING id` }));
  const [pinned] = await commit(db, pin.bind(path, JSON.stringify(value), scope.projectId, run.id, ...authority.params as BindValue[], path));
  if (pinned.results.length === 1) return { committed: true };
  if (lease !== undefined && await workerRunLeaseExpiry(db, scope, run.id, lease.worker, lease.now, run.dispatchedBy ?? undefined) === null) return null;
  const fresh = await getRun(db, scope, run.id);
  if (fresh === null || fresh.status !== 'running' || fresh.dispatchedBy !== run.dispatchedBy) return null;
  return { committed: false, row: fresh };
}

/** A held knowledge attempt records unavailable code access and continues with its original knowledge material. */
export async function recordKnowledgeRepositoryUnavailable(db: RelationalStore, scope: ReadScope, run: RunRow,
  failure: RepositoryFailure, lease: RunLease): Promise<boolean> {
  if (run.dispatchedBy === null || !KNOWLEDGE_REPOSITORY_TASKS.includes(run.task ?? '')) return false;
  const authority = renewingLeaseAuthority(lease.worker, lease.now, run.dispatchedBy, true);
  const heldCheckout = knowledgeCheckoutHeld(leaseShape(lease.worker, run.dispatchedBy), shape => read<BindValue[], { checkout: string | null; instruction: string | null }>({ name: `runs.knowledgeCheckoutHeld${shape}`, sql:
    `SELECT json_type(run_context,'$.checkout') AS checkout,instruction FROM agent_runs WHERE project_id=? AND id=? AND ${authority.sql}` }));
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const [[prompt]] = await readSet(db, instructionRead.bind(scope.projectId, run.id));
    // The rewrite lands only over the instruction it is derived from; a newer instruction is read again and rewritten.
    const mutation = knowledgeUnavailable(lease.worker,knowledgeOnlyInstruction(prompt?.instruction ?? ''),scope.projectId,run.id,prompt?.instruction ?? null,lease.now,run.dispatchedBy);
    const result = await commitAttributedWrite(db,scope,mutation,{runId:run.id,toolName:'worker_repository',op:'unavailable',
      detail:{code:failure.code},recordedAt:lease.now});
    if (result.results.length === 1) return true;
    const held = await first(db, heldCheckout.bind(scope.projectId, run.id, ...authority.params as BindValue[]));
    if (held === null) return false;
    if (held.checkout === null) return true;
    if (held.checkout !== 'object' || held.instruction === (prompt?.instruction ?? null)) return false;
  }
  return false;
}
