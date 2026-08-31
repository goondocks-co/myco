/**
 * The lean server-mode runner: one agent run inside a container that holds no
 * vault, speaking to the Deployment over HTTP.
 *
 * `runAgent` is the full local executor — its context, tools, and conditions
 * read the local vault ambiently, which a container does not have. This runner
 * reuses the pieces that are pure (task definitions, prompt composition, the
 * harness adapters) and reaches storage exclusively through the run-control
 * routes: the claim, the status updates, and a materialized tool surface whose
 * only tool records reports over `POST /runs/report`.
 */
import { z } from 'zod/v4';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import type { RequestBudget } from '@myco/member/budget.js';
import type { ServerClient } from '@myco/member/transport.js';
import { getAgentHarness } from '../harness/index.js';
import { inferHarnessFromProviderType } from '../provider-harness.js';
import { HARNESS_CLAUDE_SDK } from '../types.js';
import { loadAgentDefinition, loadSystemPrompt, resolveDefinitionsDir } from '../loader.js';
import { loadAllTasks } from '../registry.js';
import { composeTaskPrompt } from '../prompt-composition.js';
import type { AgentHarness } from '../harness/types.js';
import type { ProviderConfig } from '../types.js';
import type { MycoToolDefinition } from '../tools/types.js';
import { createHttpRunStore, postRunReport } from './run-store-http.js';

/** What a server task run needs; everything arrives in the dispatch, nothing is read ambiently. */
export interface ServerTaskOptions {
  client: ServerClient;
  budget: RequestBudget;
  runId: string;
  taskName: string;
  agentId?: string;
  timeoutSeconds?: number;
  provider?: ProviderConfig;
  model?: string;
  instruction?: string;
  /** Test seam: the harness to execute with; resolved from the task's configuration when absent. */
  harness?: AgentHarness;
}

export interface ServerTaskResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  reportCount: number;
}

/** The one tool a server run holds in this slice: reports over the run-control surface. */
export function materializedReportTool(
  client: ServerClient,
  budget: RequestBudget,
  ids: { runId: string; agentId: string },
  counter: { reports: number },
): MycoToolDefinition {
  return {
    name: 'vault_report',
    description: 'Record an observability report for the current run. Use action "skip" when skipping expected operations, with reasoning in the summary field.',
    inputSchema: {
      action: z.string().describe('Action name (e.g., extract, digest, container-smoke, skip)'),
      summary: z.string().describe('Human-readable summary of what was done'),
      details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { action: string; summary: string; details?: Record<string, unknown> }) => {
      await postRunReport(client, budget, {
        runId: ids.runId,
        agentId: ids.agentId,
        action: args.action,
        summary: args.summary,
        details: args.details === undefined ? null : JSON.stringify(args.details),
      });
      counter.reports += 1;
      return { content: [{ type: 'text', text: `report recorded: ${args.action}` }] };
    },
  };
}

/**
 * Execute one task end to end: claim, run the harness with the materialized
 * surface, and record the terminal status. Never throws — the container's
 * answer is the run row, and a thrown error would leave it `running` until
 * the stale sweep.
 */
export async function runServerTask(options: ServerTaskOptions): Promise<ServerTaskResult> {
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const { client, budget, runId, taskName } = options;
  const store = createHttpRunStore({
    client,
    agentId,
    // The claim's admission is decided server-side from the task; this
    // surface never asks admission separately.
    capabilityForTask: () => 'cortex',
    budget,
  });

  try {
    const definitionsDir = resolveDefinitionsDir();
    const definition = loadAgentDefinition(definitionsDir);
    const task = loadAllTasks(definitionsDir).get(taskName);
    if (task === undefined) {
      return { runId, status: 'failed', error: `unknown task: ${taskName}`, reportCount: 0 };
    }
    const systemPrompt = loadSystemPrompt(definitionsDir, definition.systemPromptPath);

    // The harness follows the provider, exactly as the local executor infers
    // it; a local-provider dispatch under the wrong harness would spawn the
    // wrong runtime.
    const harnessId = options.provider?.type === undefined ? HARNESS_CLAUDE_SDK : inferHarnessFromProviderType(options.provider.type);
    // No started_at: the server stamps its own clock, the only clock the
    // single-flight guard compares against.
    const claim = await store.claimRun(
      {
        id: runId,
        agent_id: agentId,
        task: taskName,
        status: 'running',
        harness: harnessId,
        provider: options.provider?.type ?? null,
        model: options.model ?? null,
      },
      { taskName, maxAgeSeconds: (options.timeoutSeconds ?? task.timeoutSeconds ?? 300) + 300 },
    );
    if ((claim as { claimed?: boolean } | undefined)?.claimed === false) {
      return { runId, status: 'skipped', reportCount: 0 };
    }

    const counter = { reports: 0 };
    const reportTool = materializedReportTool(client, budget, { runId, agentId }, counter);
    const harness = options.harness ?? getAgentHarness(harnessId);
    const prompt = composeTaskPrompt({
      vaultContext: '',
      taskDisplayName: task.displayName ?? taskName,
      taskPrompt: task.prompt ?? '',
      instruction: options.instruction,
    });

    const abort = new AbortController();
    const timeoutMs = (options.timeoutSeconds ?? task.timeoutSeconds ?? 300) * 1000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const result = await harness.execute({
        prompt,
        model: options.model ?? task.model ?? 'claude-opus-5',
        maxTurns: task.maxTurns,
        systemPrompt,
        provider: options.provider,
        toolSurface: { agentId, runId, tools: [reportTool] },
        abortController: abort,
        reasoningLevel: task.reasoningLevel,
      });
      await store.updateRunStatus(runId, 'completed', {
        completed_at: Date.now(),
        tokens_used: result.usage?.totalTokens ?? null,
      });
      return { runId, status: 'completed', reportCount: counter.reports };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await store.updateRunStatus(runId, 'failed', { completed_at: Date.now(), error: message });
    } catch {
      // The terminal update is best-effort: the stale sweep closes the row
      // when the Deployment is unreachable, and the container's log holds
      // the message either way.
    }
    return { runId, status: 'failed', error: message, reportCount: 0 };
  }
}
