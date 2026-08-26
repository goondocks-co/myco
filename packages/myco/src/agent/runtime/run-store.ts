/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The agent run control plane, as a port.
 *
 * Every operation is async because a server-side implementation cannot be
 * synchronous. That asynchrony is the whole hazard: `phase-loop.ts` dispatches
 * the phases of a wave concurrently via `Promise.allSettled`, and today nothing
 * guards a read-modify-write across two concurrent phases except the fact that
 * `bun:sqlite` is synchronous — the single-threaded loop cannot interleave what
 * never yields. Introducing `await` at those boundaries removes that guarantee
 * silently: no test fails, and two phases can read the same state value, both
 * decide, and both write.
 *
 * **A generic mutex does not fix this, and the gate proves it.** Serializing
 * individual operations still lets two phases interleave as
 * get(A) get(B) set(A) set(B) — every operation ran alone, and B's write still
 * clobbered A's. What sync SQLite actually guarantees is that the whole
 * synchronous span between yields is atomic, which no per-call wrapper
 * reproduces.
 *
 * So atomicity is expressed in the port itself: `mutateState` is one operation
 * that reads, applies, and writes. That is also the shape a server
 * implementation can honour — a conditional UPDATE, or a `RelationalStore.batch()`,
 * both of which are atomic by contract. `serializeRunStore` then supplies
 * ordering, not atomicity.
 */

import type { AgentStateRow } from '@myco/db/queries/agent-state.js';
import type { RunInsert, RunRow, RunUpdate, RunningRunRef } from '@myco/db/queries/runs.js';
import type { ReportRow } from '@myco/db/queries/reports.js';
import type { RunEventInsert } from '@myco/db/queries/agent-run-events.js';
import type { CortexInstructionsUpsert } from '@myco/db/queries/cortex-instructions.js';

export type { RunInsert, RunRow, RunUpdate, RunningRunRef, ReportRow, RunEventInsert, CortexInstructionsUpsert };

/**
 * A store is BOUND to one run's tenancy at construction, so no operation
 * re-derives scope.
 *
 * This is a correctness boundary, not ergonomics. `projectScopeFromRequestContext`
 * (`grove/request-context.ts:925-933`) resolves a synthesized or non-Grove-bound
 * context to GLOBAL_SCOPE precisely because binding it to a project scope "would
 * leak the anchor's rows to an unauthorized request". A port that accepted a
 * bare `projectId` per call would invite every implementation to re-derive that
 * decision, and to get it wrong the same way. The caller resolves tenancy once;
 * the store carries it.
 *
 * Binding also matches the serialization lifetime: one store per run means the
 * mutex scopes to a run, so concurrent runs never contend while concurrent
 * phases within a run do.
 */

/** Whether a run may start, and why not. */
export interface RunAdmission {
  admitted: boolean;
  reason?: string;
  ownerOp?: string;
}

export interface RunStore {
  // -- run lifecycle -------------------------------------------------------
  insertRun(row: RunInsert): Promise<void>;
  /**
   * Single-flight claim: check for a live run of `guard.taskName` and insert
   * `row` only if there is none, ATOMICALLY.
   *
   * This exists because the check and the insert used to be adjacent
   * synchronous statements — the executor's own comment read "This check and
   * the insert below run with no await between them, so the second dispatch
   * always sees the first one's row." Awaiting a port breaks that, and two
   * same-tick dispatches both insert.
   *
   * `serializeRunStore` cannot close this one: its mutex is per store and the
   * executor builds one store per run, so two concurrent dispatches hold two
   * different mutexes. Cross-run coordination has to be one operation the
   * store performs atomically — a transaction locally, a conditional INSERT
   * on a server.
   */
  claimRun(
    row: RunInsert,
    guard: { taskName: string; maxAgeSeconds: number },
  ): Promise<{ claimed: true } | { claimed: false; running: RunningRunRef }>;
  getRun(runId: string): Promise<RunRow | null>;
  getRunningRunForTask(task: string, maxAgeSeconds?: number): Promise<RunningRunRef | null>;
  updateRunStatus(runId: string, status: string, completion?: RunUpdate): Promise<void>;
  applyRunUpdate(runId: string, update: RunUpdate): Promise<void>;
  supersedeEquivalentResumableRuns(
    excludeRunId: string,
    match: { taskName: string; dryRun: boolean },
  ): Promise<void>;

  // -- run observability ---------------------------------------------------
  recordRunEvent(event: RunEventInsert): Promise<void>;
  listReports(runId: string): Promise<ReportRow[]>;

  // -- agent state ---------------------------------------------------------
  getState(key: string, projectId: string): Promise<AgentStateRow | null>;
  setState(key: string, value: string, projectId: string, updatedAt?: number): Promise<void>;
  /**
   * Atomic read-modify-write. `mutate` receives the current value (null when
   * unset) and returns the next; returning `null` leaves the value untouched.
   *
   * Every read-modify-write on agent state MUST go through this rather than a
   * `getState` / `setState` pair — see the module docblock and the R2 gate.
   */
  mutateState(
    key: string,
    mutate: (current: string | null) => string | null,
    projectId: string,
  ): Promise<void>;

  // -- derived outputs -----------------------------------------------------
  upsertCortexInstructions(row: CortexInstructionsUpsert): Promise<void>;

  /**
   * Admission gate, asked before a run starts.
   *
   * Locally this reads a machine-local project lease under `resolveMycoHome()`
   * — NOT the vault. That is why it belongs to the port: a server-side agent
   * has no `~/.myco`, and the executor's inline gate fails CLOSED on an
   * unreadable lease, so every run would be refused with no crash and no
   * signal. Making admission an explicit port operation forces each
   * implementation to answer for itself instead of inheriting a local answer.
   */
  admitProject(projectId: string): Promise<RunAdmission>;
}

/**
 * Wrap a store so no two of its operations overlap.
 *
 * Serialization is per wrapper instance, and the executor creates one per run —
 * concurrent runs do not contend, concurrent phases within a run do.
 *
 * The chain is held as a promise rather than a lock flag so that a rejected
 * operation cannot wedge the queue: every link settles before the next starts,
 * and a failure propagates to its own caller only.
 */
export function serializeRunStore(inner: RunStore): RunStore {
  let chain: Promise<unknown> = Promise.resolve();

  const serialized = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ) => (...args: Args): Promise<Result> => {
    const result = chain.then(() => operation.apply(inner, args));
    // Swallow rejection on the CHAIN only; `result` keeps it for the caller.
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    insertRun: serialized(inner.insertRun),
    claimRun: serialized(inner.claimRun),
    getRun: serialized(inner.getRun),
    getRunningRunForTask: serialized(inner.getRunningRunForTask),
    updateRunStatus: serialized(inner.updateRunStatus),
    applyRunUpdate: serialized(inner.applyRunUpdate),
    supersedeEquivalentResumableRuns: serialized(inner.supersedeEquivalentResumableRuns),
    recordRunEvent: serialized(inner.recordRunEvent),
    listReports: serialized(inner.listReports),
    getState: serialized(inner.getState),
    setState: serialized(inner.setState),
    mutateState: serialized(inner.mutateState),
    upsertCortexInstructions: serialized(inner.upsertCortexInstructions),
    admitProject: serialized(inner.admitProject),
  };
}
