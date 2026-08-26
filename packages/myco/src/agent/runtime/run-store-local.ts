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
 * Local `RunStore` over the existing synchronous vault queries.
 *
 * **This is a test seam, not a production adapter.** 2.0 removes the local
 * harness — #905 leaves a thin Member Service, and #925 retires the local-vault
 * runtime paths. Its purpose is to keep the agent suite executable while the
 * control plane converts; retiring it belongs to #925, not to a later cleanup
 * nobody scheduled.
 *
 * Two things this adapter deliberately absorbs so the port does not:
 *
 * - **Grove.** `ProjectScope` comes from `@myco/grove/ids.js`, which #905
 *   retires. The store is constructed with an ALREADY-RESOLVED scope and never
 *   re-derives one: `projectScopeFromRequestContext` resolves a synthesized or
 *   non-Grove-bound context to GLOBAL_SCOPE because binding it to a project
 *   would "leak the anchor's rows to an unauthorized request"
 *   (`grove/request-context.ts:925-933`). Re-deriving scope from a bare
 *   `projectId` here would reintroduce exactly that.
 * - **Atomicity.** `mutateState` reads and writes with no `await` between, so
 *   `bun:sqlite` being synchronous makes it atomic for free. A networked
 *   implementation must supply that explicitly — a conditional UPDATE, or a
 *   `RelationalStore.batch()`.
 */

import { epochSeconds } from '@myco/constants.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { getState, setState } from '@myco/db/queries/agent-state.js';
import { listReports } from '@myco/db/queries/reports.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import {
  insertRun,
  getRun,
  getRunningRunForTask,
  updateRunStatus,
  applyRunUpdate,
  supersedeEquivalentResumableRuns,
} from '@myco/db/queries/runs.js';
import type { RunStore } from './run-store.js';

/** Tenancy the store is bound to, resolved once by the caller. */
export interface LocalRunStoreBinding {
  /** Already resolved via `projectScopeFromRequestContext` — never re-derived. */
  scope: ProjectScope;
  agentId: string;
}

export function createLocalRunStore(binding: LocalRunStoreBinding): RunStore {
  const { scope, agentId } = binding;
  return {
    async insertRun(row) {
      insertRun(row);
    },

    /**
     * Atomic because the check and the insert are adjacent synchronous
     * statements — the exact invariant the executor relied on before the
     * control plane became a port.
     */
    async claimRun(row, guard) {
      const running = getRunningRunForTask(agentId, guard.taskName, scope, guard.maxAgeSeconds);
      if (running && !running.stale) return { claimed: false, running };
      insertRun(row);
      return { claimed: true };
    },

    async getRun(runId) {
      return getRun(runId, scope);
    },

    async getRunningRunForTask(task, maxAgeSeconds) {
      return getRunningRunForTask(agentId, task, scope, maxAgeSeconds);
    },

    async updateRunStatus(runId, status, completion) {
      updateRunStatus(runId, status, completion, scope);
    },

    async applyRunUpdate(runId, update) {
      applyRunUpdate(runId, update, scope);
    },

    async supersedeEquivalentResumableRuns(excludeRunId, match) {
      supersedeEquivalentResumableRuns(excludeRunId, {
        agentId,
        taskName: match.taskName,
        scope,
        dryRun: match.dryRun,
      });
    },

    async recordRunEvent(event) {
      insertRunEvent(event);
    },

    async listReports(runId) {
      return listReports(runId, { scope });
    },

    async getState(key, projectId) {
      return getState(agentId, projectId, key);
    },

    async setState(key, value, projectId, updatedAt) {
      setState(agentId, projectId, key, value, updatedAt ?? epochSeconds());
    },

    /**
     * Atomic because nothing yields between the read and the write — the same
     * property the whole conversion is trying to preserve, here for free.
     */
    async mutateState(key, mutate, projectId) {
      const current = getState(agentId, projectId, key);
      const next = mutate(current ? current.value : null);
      if (next === null) return;
      setState(agentId, projectId, key, next, epochSeconds());
    },

    async upsertCortexInstructions(row) {
      upsertCortexInstructions(row);
    },
  };
}
