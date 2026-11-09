import type { Bound } from '../db/index.js';
import type { ProjectCapability } from './settings.js';
import type { DispatchLimits } from './limits.js';
import type { ClaimBudget } from './run-budget.js';
import type { MemberWriteActor } from '../auth/member-write-store.js';
import { DISPATCH_ACTOR_SQL } from '../db/run-context.js';
import type { RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';

/**
 * The agent run control plane, server-side.
 *
 * The agent does not reach this store. It runs as a process inside a container,
 * which is not a Worker and holds no bindings, so it calls the routes in
 * `api/runs.ts` and this module is what those routes call. That arrangement is
 * the point: atomicity lives with the single writer instead of once per client.
 *
 * Three operations here are atomic in SQL rather than in JavaScript, and each is
 * atomic in the WHERE clause rather than by batching. A batch cannot supply any
 * of them: its statements are fixed before it executes, so any decision taken
 * between a read and a write still happens in the caller, across an await, where
 * two concurrent phases interleave.
 *
 * - `claimRun` is one `INSERT ... SELECT ... WHERE NOT EXISTS`. A separate check
 *   followed by a separate insert admits a run twice under one id.
 * - `mutateState` is compare-and-swap. The caller's callback is arbitrary code
 *   and cannot move into SQL, so the prior value becomes the guard and a refused
 *   update is retried FROM THE READ. Retrying from anywhere else re-applies a
 *   decision taken against a value that is no longer there.
 * - `applyRunUpdate` guards a status change on the row not already being
 *   terminal. A run closing releases the container that ran it, and that release
 *   is what makes the container post an ending of its own, so the two writes
 *   overlap by construction and only the WHERE clause can settle which lands.
 */

/** The name a dispatch is left alone under when the Project has not moved past the artifact its task already wrote. */

/** The context a skipped run carries: one shape, written by both skip paths and matched exactly by the interval clock. */
export const skipContext = (reason: string): string => JSON.stringify({ reason });

export interface RunInsert {
  id: string;
  agentId: string;
  task: string | null;
  instruction: string | null;
  harness: string | null;
  provider: string | null;
  model: string | null;
  dryRun: boolean;
  startedAt: number;
  runContext: string | null;
  /** The credential that dispatched this run, or null when a schedule did. Supplies member and runtime attribution through `member_credentials`. */
  dispatchedBy: string | null;
}

/** A live run of a task, as much of it as a caller refused a claim needs. */
export interface RunningRunRef {
  id: string;
  task: string | null;
  startedAt: number | null;
  /** When the current attempt began, distinct from `startedAt` on a resumed run. */
  resumedAt: number | null;
}

/**
 * What must hold before a task may run.
 *
 * Capability-gated work requires Project admission; embedding work requires a
 * bound provider. Capture-driven title work carries no provider-setting gate:
 * worker selection and execution profiles resolve at the worker claim.
 */
export type RunAdmissionGate =
  | { kind: 'capability'; capability: ProjectCapability }
  | { kind: 'embedding' }
  | { kind: 'capture' };

/**
 * Why a claim did not take.
 *
 * `running` names the run already recorded under this id. `notAdmitted` names a
 * Project that does not hold the capability the task needs, and `noProvider` a
 * Deployment with no embedding provider — settled answers a caller must not retry into.
 */
export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; running: RunningRunRef | null; notAdmitted?: undefined; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted: ProjectCapability; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted?: undefined; noProvider: true };

/**
 * Which runs are in flight.
 *
 * A `pending` row counts as one: the dispatcher writes the row before the
 * runtime starts. Every reader of the fleet shares this predicate — the sweep,
 * the drain's load, and the read a deploy makes before it recreates the
 * container — and each projects the columns it needs from it.
 */



/** The actor a dispatch spec names, and null for a spec that names none. A spec the store did not write is not read as JSON at all. */
export { DISPATCH_ACTOR_SQL };

/**
 * A ceiling on the entries one actor may make of a task in a window,
 * across the Deployment or within one Project: the write that records the run refuses once the
 * window holds that many, in the same statement that counts them.
 */
export interface ActorCeiling {
  actor: string;
  task: string;
  perDay: number;
  sinceMs: number;
  /** Restrict this ceiling to one Project; absent spans the Deployment. */
  projectId?: string;
}

/**
 * What a write is admitted against, or none: an unguarded write is a claim the
 * dispatcher already decided elsewhere. `singleFlight` names a task that runs
 * once at a time in a Project: the write refuses while another run of it is
 * live, in the same statement, so two wakes deciding at once write one row.
 * `ceiling` names an actor's window the write refuses past. `capability` names one the Project must
 * have turned on.
 */
export interface WriteAdmission {
  limits: DispatchLimits;
  now: number;
  budget?: ClaimBudget;
  settingsGuard?: Readonly<Record<string,number>>;
  singleFlight?: boolean;
  ceiling?: ActorCeiling;
  actor?: MemberWriteActor;
  setup?: Bound[];
  /** A capability the Project must have turned on for the write to land. */
  capability?: string;
}

export interface DispatchRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  /** The prompt the server built for this run, or null for a task the server builds no input for. The run reads it back over `/runs/instruction`. */
  instruction?: string | null;
  /** A run that does the work and writes nothing; its write routes answer `written: false`. */
  dryRun?: boolean;
  /** The dispatch's parameters, which the run routes that serve one task read back; written here, by the server, and never by the runtime. */
  runContext: string | null;
  /** The credential the dispatch minted for this run. */
  dispatchedBy: string | null;
  startedAt: number;
  dispatchSpec?: string;
}



// The queue: a run that waits is a run row
// ---------------------------------------------------------------------------

/** What a queued run keeps until it launches: everything a launch is told, so the drain launches it exactly as the dispatch asked. */
export interface QueuedRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  heldBy: string;
  queuedAt: number;
  /** The prompt the server built at the dispatch. A task with an input builder has it rebuilt at launch, and this is what the rebuild replaces. */
  instruction?: string | null;
  /** A run that does the work and writes nothing. */
  dryRun?: boolean;
  /** The launch spec as JSON: server URL, actor, bound and parameters. */
  dispatchSpec: string;
  /** What the run carries on its row: the task's parameters and what the server decided at dispatch. A run a worker claims is never launched, so this is written here or nowhere. */
  runContext?: string | null;
}

/** What ending a queued row did: whether the write landed, and the credential that row named when it did. */
export interface QueuedRunEnd {
  applied: boolean;
  displaced: string | null;
}

/**
 * A queued run the Deployment can no longer launch is failed by name, from
 * `queued` alone.
 *
 * `started_at` is left as it is, as it is for a skipped row: a run that never
 * ran has no start, and `taskRunsLastHour` counts starts. The write answers
 * with the credential the row named at the instant it landed, for the same
 * reason a skip does.
 */

export interface QueuedRunRef {
  projectId: string;
  id: string;
  task: string | null;
  queuedAt: number;
  heldBy: string | null;
  budgetQuoteUsd:number|null;
  dispatchSpec: string | null;
  origin: 'manual' | 'automatic';
  /** The credential a re-queued row still carries, for the child a late answer may have started; null for a row that never launched. */
  dispatchedBy: string | null;
}


/**
 * The claim queue, as a worker sees it.
 *
 * Two statements rather than one: the candidate is read, then taken by a write
 * guarded on everything the read relied on. Two workers reading the same row
 * both attempt the write and exactly one changes a row, which is the same shape
 * the dispatched claim already uses and needs no row-value support.
 *
 * `dispatched_by IS NULL` is what keeps this queue disjoint from the launch
 * path's. A queued row that still names a credential belongs to a launch the
 * queue took back while its child runs, and that child claims under the
 * credential the row names; a worker must never take it. `expireLeases` clears the column when it
 * requeues, which is what makes a run it held claimable again.
 */
export interface ClaimCandidate {
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  dispatchSpec: string | null;
}

export interface ClaimedRunRow {
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  runContext: string | null;
  dryRun: number;
}


/** A pulled run the claim creates: its identity, single-flight subject, built input and its stage's reassertion. */
export interface PulledCandidate {
  projectId: string;
  id: string;
  task: string;
  subject: string;
  input: ClaimedInput;
  /** The selection the stage reasserts inside the write: level, head and fairness. */
  assertions: readonly Bound[];
  /** What the stage adds to the claim's batch, given the attempt the batch mints. */
  claimed?: (dispatchedBy: string) => Bound[];
}

/**
 * Take one queued run for a worker.
 *
 * The row reaches `running` and names its credential in the same statement: a
 * claim that answered a credential the row did not yet name would leave a run
 * the MCP surface resolves nothing for while it looked healthy. `started_at` is
 * rewritten so the task budget bounds the run rather than its wait in the queue.
 * The attempt the claim starts is recorded in the same batch, and only where the
 * claim landed (`core/run-steps.ts`).
 */

/** The prompt a claim rebuilt, and the hash and counts the server filed it under, onto the row a worker now holds. */
export interface ClaimedInput { instruction: string; instructions?: string; inputHash: string; counts: Readonly<Record<string, number | boolean>>; repository?: RepositoryCheckoutSpec; context?: Readonly<Record<string, unknown>>; subject?: string }



// ---------------------------------------------------------------------------
// What the clock reads before it schedules a task, per Project
// ---------------------------------------------------------------------------

/** Unattributed legacy runs count conservatively against an actor's budget. */
export const UNATTRIBUTED_DISPATCH_ACTOR = '';
/** Whether an actor dispatched a run, or any actor where none is named. Bound as `actorParams`. */
