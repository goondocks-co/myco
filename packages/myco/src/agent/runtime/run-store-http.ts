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
 * `RunStore` over the Deployment's run-control routes.
 *
 * This is the production adapter. The agent runs as a process inside a
 * container, which is not a Worker and holds no bindings, so it reaches the
 * store the only way it can: an authenticated request over the same client the
 * member's capture already uses.
 *
 * **The atomicity is not here.** `claimRun` is decided by one SQL statement on
 * the server, and `mutateState` by a guarded UPDATE there. What this file owns
 * is the part that cannot cross a process boundary: `mutate` is a JavaScript
 * callback, so the read, the call, and the retry on a lost guard happen on this
 * side while the decision stays on that one. Retrying anywhere but from the read
 * re-applies a decision taken against a value that is no longer there.
 */

import type { AgentStateRow } from '@myco/db/queries/agent-state.js';
import type { RunInsert, RunRow, RunUpdate, RunningRunRef } from '@myco/db/queries/runs.js';
import type { ReportRow } from '@myco/db/queries/reports.js';
import type { RunEventInsert } from '@myco/db/queries/agent-run-events.js';
import type { CortexInstructionsUpsert } from '@myco/db/queries/cortex-instructions.js';
import type { RequestBudget } from '@myco/member/budget.js';
import type { RawAnswer, ServerClient } from '@myco/member/transport.js';
import type { RunAdmission, RunStore } from './run-store.js';

/** How many times a refused compare-and-swap is recomputed before the write is reported as contended. */
export const HTTP_MUTATE_ATTEMPTS = 5;

/**
 * The capability a task needs, supplied by the task catalogue.
 *
 * Taken rather than held: the catalogue lives with the tasks, and a second copy
 * inside the transport is the one that goes stale without saying so when a task
 * is added.
 */
export type CapabilityForTask = (task: string) => string;

export interface HttpRunStoreOptions {
  client: ServerClient;
  agentId: string;
  capabilityForTask: CapabilityForTask;
  budget: RequestBudget;
}

/**
 * A Project the Deployment has not admitted to the capability a task needs.
 *
 * Thrown rather than returned as a refused claim: the port's `claimRun` reports
 * contention, and a caller that read this as contention would retry a condition
 * only an operator can clear.
 */
export class ProjectNotAdmittedError extends Error {
  constructor(readonly capability: string, readonly task: string) {
    super(`project is not admitted to ${capability}, which ${task} requires`);
    this.name = 'ProjectNotAdmittedError';
  }
}

/** A server answer that is not a 200 the route classified itself. */
export class RunControlError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`run control ${path}: ${detail}`);
    this.name = 'RunControlError';
  }
}

function body(answer: RawAnswer, path: string): Record<string, unknown> {
  if (answer.kind === 'timeout') throw new RunControlError(path, `timed out during ${answer.phase}`);
  if (answer.kind === 'transport') throw new RunControlError(path, answer.detail);
  if (answer.status !== 200 || answer.json === null) throw new RunControlError(path, `status ${answer.status}`);
  // A terminal refusal answers 200 with `persisted:false` and a stable code; it
  // is the caller's own request that is wrong, so it must not be retried.
  if (answer.json.persisted === false) {
    throw new RunControlError(path, `${String(answer.json.code ?? 'refused')}: ${String(answer.json.reason ?? '')}`);
  }
  return answer.json;
}

/** Record one report over the run-control surface; the server refuses a run this Project does not hold. */
export async function postRunReport(
  client: ServerClient,
  budget: RequestBudget,
  report: { runId: string; agentId: string; action: string; summary: string; details?: string | null },
): Promise<void> {
  const answer = await client.request('POST', '/runs/report', {
    body: JSON.stringify(report),
    headers: { 'content-type': 'application/json' },
    budget,
  });
  body(answer, '/runs/report');
}

export function createHttpRunStore(opts: HttpRunStoreOptions): RunStore {
  const { client, agentId, capabilityForTask, budget } = opts;

  const post = async (path: string, payload: unknown): Promise<Record<string, unknown>> =>
    body(await client.request('POST', path, {
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      budget,
    }), path);

  const readState = async (key: string): Promise<{ value: string | null; updatedAt: number | null }> => {
    const answered = await post('/runs/state/read', { agentId, key });
    return { value: (answered.value as string | null) ?? null, updatedAt: (answered.updatedAt as number | null) ?? null };
  };

  return {
    async insertRun(row) {
      // Every insert on this surface is a claim: an unguarded insert would admit
      // the second dispatch the claim exists to refuse.
      await this.claimRun(row, { taskName: row.task ?? '', maxAgeSeconds: 0 });
    },

    async claimRun(row: RunInsert, guard) {
      const capability = capabilityForTask(guard.taskName);
      const answered = await post('/runs/claim', {
        id: row.id,
        agentId: row.agent_id,
        task: row.task ?? guard.taskName,
        instruction: row.instruction ?? null,
        harness: row.harness ?? null,
        provider: row.provider ?? null,
        model: row.model ?? null,
        runContext: row.run_context ?? null,
        dryRun: row.dryRun === true,
        startedAt: row.started_at ?? null,
        maxAgeSeconds: guard.maxAgeSeconds,
        capability,
      });
      if (answered.claimed === true) return { claimed: true };
      if (answered.notAdmitted !== undefined) throw new ProjectNotAdmittedError(String(answered.notAdmitted), guard.taskName);
      const running = answered.running as { id: string; startedAt: number | null; resumedAt: number | null } | null;
      return {
        claimed: false,
        running: {
          id: running?.id ?? '',
          started_at: running?.startedAt ?? null,
          // The server refuses a claim only while the run is INSIDE the window,
          // so anything it reports back is by construction not stale.
          stale: false,
        } satisfies RunningRunRef,
      };
    },

    async getRun(runId) {
      const answered = await post('/runs/get', { runId });
      return (answered.run as RunRow | null) ?? null;
    },

    async getRunningRunForTask(task, maxAgeSeconds) {
      // Asked as a claim that cannot win: the server answers with the live run
      // when one holds the task, which is the same question without a second
      // read path that could disagree with the claim's.
      const answered = await post('/runs/claim', {
        id: '', agentId, task, maxAgeSeconds: maxAgeSeconds ?? 0, capability: capabilityForTask(task),
      });
      const running = answered.running as { id: string; startedAt: number | null } | null;
      return running ? { id: running.id, started_at: running.startedAt ?? null, stale: false } : null;
    },

    async updateRunStatus(runId, status, completion) {
      await post('/runs/update', { runId, update: { status, ...toColumns(completion) } });
    },

    async applyRunUpdate(runId, update) {
      await post('/runs/update', { runId, update: toColumns(update) });
    },

    async supersedeEquivalentResumableRuns(excludeRunId, match) {
      await post('/runs/supersede', { excludeRunId, agentId, taskName: match.taskName, dryRun: match.dryRun });
    },

    async recordRunEvent(event: RunEventInsert) {
      await post('/runs/events', {
        events: [{
          runId: event.runId,
          phaseName: event.phaseName ?? null,
          eventType: event.eventType,
          toolName: event.toolName ?? null,
          outcome: event.outcome ?? null,
          durationMs: event.durationMs ?? null,
          payload: event.payload ?? null,
          ...(event.recordedAt === undefined ? {} : { recordedAt: event.recordedAt }),
        }],
      });
    },

    async listReports(runId) {
      const answered = await post('/runs/reports', { runId });
      return (answered.reports as ReportRow[]) ?? [];
    },

    async getState(key) {
      const { value, updatedAt } = await readState(key);
      return value === null ? null : ({ agent_id: agentId, key, value, updated_at: updatedAt ?? 0 } as AgentStateRow);
    },

    async setState(key, value) {
      const current = await readState(key);
      const answered = await post('/runs/state/write', { agentId, key, value, expected: current.value });
      if (answered.applied !== true) throw new RunControlError('/runs/state/write', 'another writer moved the value');
    },

    async mutateState(key, mutate) {
      for (let attempt = 0; attempt < HTTP_MUTATE_ATTEMPTS; attempt += 1) {
        const current = await readState(key);
        const next = mutate(current.value);
        if (next === null) return;
        const answered = await post('/runs/state/write', { agentId, key, value: next, expected: current.value });
        if (answered.applied === true) return;
      }
      throw new RunControlError('/runs/state/write', `value moved under ${HTTP_MUTATE_ATTEMPTS} attempts`);
    },

    async upsertCortexInstructions(row: CortexInstructionsUpsert) {
      await post('/runs/cortex-instructions', {
        agentId: row.agent_id,
        content: row.content,
        inputHash: row.input_hash,
        generatedAt: row.generated_at,
        sourceRunId: row.source_run_id ?? null,
      });
    },

    async admitProject(): Promise<RunAdmission> {
      // Asked per capability; the caller's task decides which. The claim carries
      // the enforcing check, so this answers only so a caller can say why.
      const answered = await post('/runs/admission', { capability: capabilityForTask('') });
      return answered.admitted === true
        ? { admitted: true }
        : { admitted: false, reason: `project is not admitted to ${String(answered.capability)}` };
    },
  };
}

/** The port's `RunUpdate` as the columns the update route accepts. */
function toColumns(update: RunUpdate | undefined): Record<string, unknown> {
  if (!update) return {};
  const { dryRun, reasoningLevel, executionOverrides, ...columns } = update;
  const out: Record<string, unknown> = { ...columns };
  if (dryRun !== undefined) out.dry_run = dryRun ? 1 : 0;
  if (reasoningLevel !== undefined) out.reasoning_level = reasoningLevel ?? null;
  if (executionOverrides !== undefined) out.execution_overrides = executionOverrides === null ? null : JSON.stringify(executionOverrides);
  return out;
}
