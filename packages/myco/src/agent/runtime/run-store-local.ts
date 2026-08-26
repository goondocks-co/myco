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
 * - **Grove.** `ProjectScope` comes from `@myco/grove/ids.js`, and #905 retires
 *   Grove entirely. The port speaks a plain `projectId`; the translation to a
 *   `ProjectScope` happens here, so the Grove axis stays out of the contract a
 *   server implementation has to satisfy.
 * - **Atomicity.** `mutateState` reads and writes with no `await` between, so
 *   `bun:sqlite` being synchronous makes it atomic for free. A networked
 *   implementation must supply that explicitly — a conditional UPDATE, or a
 *   `RelationalStore.batch()`.
 */

import { epochSeconds } from '@myco/constants.js';
import { projectScope, type ProjectScope } from '@myco/grove/ids.js';
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
import type { RunScope, RunStore } from './run-store.js';

/** The port speaks `projectId`; the vault queries speak Grove's `ProjectScope`. */
const toProjectScope = (scope: RunScope): ProjectScope =>
  projectScope(scope.projectId as Parameters<typeof projectScope>[0]);

export function createLocalRunStore(): RunStore {
  return {
    async insertRun(row) {
      insertRun(row);
    },

    async getRun(runId, scope) {
      return getRun(runId, toProjectScope(scope));
    },

    async getRunningRunForTask(task, scope, maxAgeSeconds) {
      return getRunningRunForTask(scope.agentId, task, toProjectScope(scope), maxAgeSeconds);
    },

    async updateRunStatus(runId, status, completion, scope) {
      updateRunStatus(runId, status, completion, toProjectScope(scope));
    },

    async applyRunUpdate(runId, update, scope) {
      applyRunUpdate(runId, update, toProjectScope(scope));
    },

    async supersedeEquivalentResumableRuns(excludeRunId, match, scope) {
      supersedeEquivalentResumableRuns(excludeRunId, {
        agentId: scope.agentId,
        taskName: match.taskName,
        scope: toProjectScope(scope),
        dryRun: match.dryRun,
      });
    },

    async recordRunEvent(event) {
      insertRunEvent(event);
    },

    async listReports(runId, scope) {
      return listReports(runId, { scope: toProjectScope(scope) }) as never;
    },

    async getState(key, scope) {
      return getState(scope.agentId, scope.projectId, key);
    },

    async setState(key, value, scope) {
      setState(scope.agentId, scope.projectId, key, value, epochSeconds());
    },

    /**
     * Atomic because nothing yields between the read and the write — the same
     * property the whole conversion is trying to preserve, here for free.
     */
    async mutateState(key, mutate, scope) {
      const current = getState(scope.agentId, scope.projectId, key);
      const next = mutate(current ? current.value : null);
      if (next === null) return;
      setState(scope.agentId, scope.projectId, key, next, epochSeconds());
    },

    async upsertCortexInstructions(row) {
      upsertCortexInstructions(row);
    },
  };
}
