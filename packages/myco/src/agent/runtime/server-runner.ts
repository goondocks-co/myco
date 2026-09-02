/**
 * The lean server-mode runner: one agent run inside a container that holds no
 * vault, speaking to the Deployment over HTTP.
 *
 * `runAgent` is the full local executor — its context, tools, and conditions
 * read the local vault ambiently, which a container does not have. This runner
 * reuses the pieces that are pure (task definitions, prompt composition, the
 * harness adapters) and reaches storage exclusively through the run-control
 * routes: the claim, the status updates, and a tool surface materialized per
 * task (`server-tools.ts`).
 */
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
import { createHttpRunStore, type RunClaimAdmission } from './run-store-http.js';
import { materializedToolsForTask } from './server-tools.js';

export { materializedReportTool } from './server-tools.js';

/** The admission a dispatch names: a capability the Project must hold, or `captureDriven` for a task gated on a provider alone. */
export const CAPTURE_DRIVEN_ADMISSION = 'captureDriven';

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
  /** The task's parameters, as the dispatcher handed them; interpolated into the prompt and recorded on the run as its context. */
  params?: Record<string, string>;
  /** The admission the claim carries, as the dispatcher decided it from the catalogue; the runtime never decides admission itself. */
  admission?: string;
  /** Test seam: the harness to execute with; resolved from the task's configuration when absent. */
  harness?: AgentHarness;
}

export interface ServerTaskResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  reportCount: number;
}

/** The claim's admission from the dispatch's word: the capture-driven marker, or a capability name. */
export function claimAdmission(admission: string | undefined): RunClaimAdmission {
  return admission === CAPTURE_DRIVEN_ADMISSION ? { captureDriven: true } : { capability: admission ?? 'cortex' };
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
  const admission = claimAdmission(options.admission);
  const store = createHttpRunStore({
    client,
    agentId,
    // The claim's admission is decided server-side from the task and handed to
    // this runtime in its dispatch; this surface never asks admission separately.
    admissionForTask: () => admission,
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
    const harnessId = (options.provider?.type === undefined ? HARNESS_CLAUDE_SDK : inferHarnessFromProviderType(options.provider.type)) ?? HARNESS_CLAUDE_SDK;
    // No started_at: the server stamps its own clock. The run's context is the
    // dispatch's parameters, which the run routes that serve one task read back.
    const claim = await store.claimRun(
      {
        id: runId,
        agent_id: agentId,
        task: taskName,
        status: 'running',
        harness: harnessId,
        provider: options.provider?.type ?? null,
        model: options.model ?? null,
        run_context: options.params === undefined ? null : JSON.stringify(options.params),
      },
      { taskName, maxAgeSeconds: 0 },
    );
    if ((claim as { claimed?: boolean } | undefined)?.claimed === false) {
      return { runId, status: 'skipped', reportCount: 0 };
    }

    const counter = { reports: 0, writes: 0 };
    const tools = materializedToolsForTask(taskName, { client, budget, runId, agentId }, counter);
    const harness = options.harness ?? getAgentHarness(harnessId);
    const prompt = composeTaskPrompt({
      vaultContext: '',
      taskDisplayName: task.displayName ?? taskName,
      taskPrompt: task.prompt ?? '',
      instruction: options.instruction,
      params: options.params,
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
        toolSurface: { agentId, runId, tools },
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
