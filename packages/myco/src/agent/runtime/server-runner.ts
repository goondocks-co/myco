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
import { composeHostedPrompt, composeTaskPrompt } from '../prompt-composition.js';
import type { AgentHarness } from '../harness/types.js';
import type { ProviderConfig } from '../types.js';
import type { RunStatusOutcome, RunStore } from './run-store.js';
import { createHttpRunStore, postRunControl, type RunClaimAdmission } from './run-store-http.js';
import { INSTRUCTED_TASKS, materializedToolsForTask, type ServerToolContext } from './server-tools.js';

export { materializedReportTool } from './server-tools.js';

/** The admission a dispatch names: a capability the Project must hold, or `captureDriven` for a task gated on a provider alone. */
export const CAPTURE_DRIVEN_ADMISSION = 'captureDriven';

/** How a run that ran past its own bound is recorded. */
export const RUN_DEADLINE_ERROR = 'the run reached its deadline';
/** How a run whose container the platform took away mid-flight is recorded. */
export const RUN_REPLACED_ERROR = 'the runtime was replaced while the run was in flight';
/** The signals a platform sends a container it is taking away. */
export const RUNTIME_STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
/** How much of a failure message rides the run row. */
export const MAX_RUN_ERROR_CHARS = 2000;
/** How many times a terminal status is offered to the Deployment before the run is left to the stale sweep. */
export const TERMINAL_UPDATE_ATTEMPTS = 2;
/**
 * The budget a dying container gets to name its run.
 *
 * A platform taking a container away allows seconds, not minutes, between its
 * signal and the kill. The run's own budget is sized for model calls; borrowing
 * it here would spend the whole grace period on one attempt that the kill
 * interrupts anyway, and the row would carry nothing.
 */
export const SIGNAL_BUDGET: RequestBudget = { connectTimeoutMs: 1_500, requestTimeoutMs: 4_000 };
/** How a run the Deployment refused to close as completed is recorded by the container that ran it. */
export const RUN_REFUSED_CLOSE_ERROR = 'the deployment refused to close this run';

/** One failure message, bounded, whatever shape it arrived in. */
export function runErrorText(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).slice(0, MAX_RUN_ERROR_CHARS);
}

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
  /** Called once the claim lands, so a container knows from which instant the run is its to fail. */
  onClaimed?: () => void;
  /**
   * Called at the instant this run posts its own ending, before the request goes.
   *
   * The Deployment releases the container as soon as a terminal status lands, and
   * the release arrives as a stop signal while the post that caused it is still
   * open. A container still holding the run at that moment names it failed on a
   * row that already closed. Releasing the hold here leaves the signal handler
   * with nothing to name, and the ending the run posted is the only one written.
   */
  onClosing?: () => void;
}

export interface ServerTaskResult {
  runId: string;
  status: 'completed' | 'failed' | 'skipped';
  error?: string;
  /** The Deployment's word when it did not apply the terminal status this run posted; `error` then names the refusal itself. */
  refused?: string;
  reportCount: number;
}

/** The claim's admission from the dispatch's word: the capture-driven marker, or a capability name. */
export function claimAdmission(admission: string | undefined): RunClaimAdmission {
  return admission === CAPTURE_DRIVEN_ADMISSION ? { captureDriven: true } : { capability: admission ?? 'cortex' };
}

/**
 * Offer one terminal status to the Deployment, twice.
 *
 * The status is the only thing that tells a reader a run ended for a reason
 * rather than went away, and a single refused request would turn a named
 * failure into the stale sweep's silence.
 */
async function recordTerminal(
  store: RunStore, runId: string, status: 'completed' | 'failed', completion: Record<string, unknown>, attempts = TERMINAL_UPDATE_ATTEMPTS,
): Promise<RunStatusOutcome> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await store.updateRunStatus(runId, status, completion as never);
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
  }
}

/** The Deployment's word when it did not apply a terminal status, or nothing when it did. */
function refusalOf(outcome: RunStatusOutcome): string | undefined {
  return outcome.applied ? undefined : outcome.reason ?? RUN_REFUSED_CLOSE_ERROR;
}

/** What a container holds while one run is in flight: enough to name that run's failure on its own row. */
export interface HeldRun {
  client: ServerClient;
  budget: RequestBudget;
  runId: string;
  agentId?: string;
}

/**
 * Record one run's failure over the run-control surface.
 *
 * `attempts` is the caller's: a run failing on its own terms offers the status
 * twice, and a container being taken away offers it once inside a budget short
 * enough to finish before the kill.
 */
export async function recordRunFailure(held: HeldRun, error: string, attempts = TERMINAL_UPDATE_ATTEMPTS): Promise<RunStatusOutcome> {
  const store = createHttpRunStore({
    client: held.client,
    agentId: held.agentId ?? DEFAULT_AGENT_ID,
    admissionForTask: () => ({ capability: 'cortex' }),
    budget: held.budget,
  });
  return recordTerminal(store, held.runId, 'failed', { completed_at: Date.now(), error: error.slice(0, MAX_RUN_ERROR_CHARS) }, attempts);
}

/** Where a process's own deaths are announced. */
export interface ProcessEvents {
  on(event: string, listener: (reason?: unknown) => void): unknown;
}

/** What the container does with a death: which run is in flight, and what to do once it has been named. */
export interface RunFailureHandlers {
  held: () => HeldRun | null;
  /** Called after the attempt to name the failure; `named` says whether a run row carries it, and `refused` carries the Deployment's word when it turned the status down. */
  onNamed: (error: string, named: boolean, refused?: string) => void;
}

/**
 * Name this container's run on its own row when the process dies.
 *
 * A container that throws, rejects, or is taken away by the platform mid-rollout
 * otherwise just stops talking, and the run stays `running` until the stale
 * sweep gives up on it minutes later under a message that says nothing about
 * what happened. Every one of those deaths reaches the row here instead.
 */
export function installRunFailureHandlers(events: ProcessEvents, handlers: RunFailureHandlers): void {
  // One death, one attempt to name it. A platform sends SIGTERM then SIGINT, and
  // sends SIGTERM again when the first is not answered; each extra pass would
  // spend the grace period re-posting a status the first pass already carried.
  let dying = false;
  const name = async (error: string, budget?: RequestBudget): Promise<void> => {
    if (dying) return;
    dying = true;
    const held = handlers.held();
    let named = false;
    let refused: string | undefined;
    if (held !== null) {
      try {
        // A run whose own ending already landed answers this status with a
        // refusal, and the row keeps the ending it carries; the container says
        // which happened rather than reporting a failure it did not write.
        const outcome = await recordRunFailure(budget === undefined ? held : { ...held, budget }, error, budget === undefined ? TERMINAL_UPDATE_ATTEMPTS : 1);
        named = outcome.applied;
        refused = refusalOf(outcome);
      } catch {
        // The stale sweep closes the row when the Deployment is unreachable.
      }
    }
    handlers.onNamed(error, named, refused);
  };
  // A handler that threw would raise `unhandledRejection` and re-enter this same
  // path; the latch above stops the loop and this stops the noise.
  const start = (error: string, budget?: RequestBudget) => { void name(error, budget).catch(() => {}); };
  events.on('uncaughtException', (reason) => { start(runErrorText(reason)); });
  events.on('unhandledRejection', (reason) => { start(runErrorText(reason)); });
  for (const signal of RUNTIME_STOP_SIGNALS) events.on(signal, () => { start(RUN_REPLACED_ERROR, SIGNAL_BUDGET); });
}

/**
 * The prompt the server built for this run, for a task that carries one.
 *
 * A build runs to tens of kilobytes, which belongs on the run row rather than in
 * a container's environment. A task the server builds no input for asks nothing,
 * and a route that answers no instruction leaves the run with none.
 */
async function instructionForRun(ctx: ServerToolContext, taskName: string): Promise<string | undefined> {
  if (!INSTRUCTED_TASKS.includes(taskName)) return undefined;
  const answered = await postRunControl(ctx.client, ctx.budget, '/runs/instruction', { runId: ctx.runId });
  return typeof answered.instruction === 'string' && answered.instruction.length > 0 ? answered.instruction : undefined;
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
    options.onClaimed?.();

    const counter = { reports: 0, writes: 0 };
    const toolContext = { client, budget, runId, agentId };
    const tools = materializedToolsForTask(taskName, toolContext, counter);
    const harness = options.harness ?? getAgentHarness(harnessId);
    // The prompt the server built for this run rides the run row rather than the
    // container's environment; the claim above is what admits this read.
    const instruction = options.instruction ?? await instructionForRun(toolContext, taskName);
    const prompt = composeTaskPrompt({
      vaultContext: '',
      taskDisplayName: task.displayName ?? taskName,
      taskPrompt: composeHostedPrompt({ taskPrompt: task.prompt ?? '', phases: task.phases }),
      instruction,
      params: options.params,
    });

    const abort = new AbortController();
    const timeoutMs = (options.timeoutSeconds ?? task.timeoutSeconds ?? 300) * 1000;
    // The deadline is raced against the execution rather than left to the abort
    // controller alone: a harness that does not honour the signal would run past
    // its bound and answer normally, and the run would close completed on work
    // the Deployment stopped waiting for.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(new Error(RUN_DEADLINE_ERROR)); }, timeoutMs);
    });
    try {
      const execution = harness.execute({
        prompt,
        model: options.model ?? task.model ?? 'claude-opus-5',
        maxTurns: task.maxTurns,
        systemPrompt,
        provider: options.provider,
        toolSurface: { agentId, runId, tools },
        abortController: abort,
        reasoningLevel: task.reasoningLevel,
      });
      // The loser of the race settles alone; its later rejection is the run's
      // outcome only when it won.
      execution.catch(() => {});
      const result = await Promise.race([execution, deadline]);
      options.onClosing?.();
      const closed = await recordTerminal(store, runId, 'completed', {
        completed_at: Date.now(),
        tokens_used: result.usage?.totalTokens ?? null,
      });
      // The Deployment decides whether a run closes; a container that logged its
      // own word over the server's would report a run finished that the row calls
      // failed, and the container's log is where a person looks first.
      const refused = refusalOf(closed);
      if (refused !== undefined) {
        return { runId, status: 'failed', error: RUN_REFUSED_CLOSE_ERROR, refused, reportCount: counter.reports };
      }
      return { runId, status: 'completed', reportCount: counter.reports };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = runErrorText(error);
    let refused: string | undefined;
    try {
      options.onClosing?.();
      refused = refusalOf(await recordTerminal(store, runId, 'failed', { completed_at: Date.now(), error: message }));
    } catch {
      // The terminal update is best-effort: the stale sweep closes the row
      // when the Deployment is unreachable, and the container's log holds
      // the message either way.
    }
    return { runId, status: 'failed', error: message, ...(refused === undefined ? {} : { refused }), reportCount: 0 };
  }
}
