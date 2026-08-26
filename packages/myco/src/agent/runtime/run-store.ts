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

/** Scope every operation is evaluated within. */
export interface RunScope {
  projectId: string;
  agentId: string;
}

export interface RunStore {
  // -- run lifecycle -------------------------------------------------------
  insertRun(row: RunInsert): Promise<void>;
  getRun(runId: string, scope: RunScope): Promise<RunRow | null>;
  getRunningRunForTask(task: string, scope: RunScope): Promise<RunRow | null>;
  updateRunStatus(runId: string, status: string, patch: RunPatch): Promise<void>;
  applyRunUpdate(runId: string, patch: RunPatch): Promise<void>;
  supersedeEquivalentResumableRuns(runId: string, scope: RunScope): Promise<void>;

  // -- run observability ---------------------------------------------------
  recordRunEvent(event: RunEvent): Promise<void>;
  listReports(runId: string, scope: RunScope): Promise<ReportRow[]>;

  // -- agent state ---------------------------------------------------------
  getState(key: string, scope: RunScope): Promise<AgentStateRow | null>;
  setState(key: string, value: string, scope: RunScope): Promise<void>;
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
    scope: RunScope,
  ): Promise<void>;

  // -- derived outputs -----------------------------------------------------
  upsertCortexInstructions(row: CortexInstructionsUpsert): Promise<void>;
}

export interface RunRow { id: string; task: string; status: string; [key: string]: unknown }
export interface RunInsert { id: string; task: string; [key: string]: unknown }
export type RunPatch = Record<string, unknown>;
export interface RunEvent { runId: string; eventType: string; toolName?: string | null; [key: string]: unknown }
export interface ReportRow { id: string; [key: string]: unknown }
export interface CortexInstructionsUpsert { projectId: string; [key: string]: unknown }

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
  };
}
