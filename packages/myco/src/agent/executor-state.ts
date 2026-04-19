import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import type { CostResolution, CostSource } from './cost/types.js';
import type {
  EffectiveConfig,
  PhaseResult,
  ProviderConfig,
  ProviderType,
  RuntimeId,
  RuntimeTokenBudget,
  RuntimeUsage,
} from './types.js';

/** Error patterns that indicate an SDK/runtime session could not be resumed. */
const SESSION_RESUME_ERROR_PATTERNS = [
  /session/,
  /resume/,
  /previous[_ ]response/,
  /conversation/,
];

/**
 * Error patterns that specifically indicate the Claude Agent SDK subprocess
 * crashed while trying to attach to an expired or missing session.
 *
 * The SDK TTLs its sessions on Anthropic's side (hours to days). When the
 * scheduler resumes a run after that TTL, the `claude` subprocess exits 1
 * within ~100 seconds with 0 turns recorded — the generic "Claude Code
 * process exited with code 1" message contains no `session`/`resume`
 * substring, so `SESSION_RESUME_ERROR_PATTERNS` misses it and the resume
 * keeps re-queuing forever.
 *
 * These patterns are only safe to apply in contexts where a `sessionRef`
 * was passed to the runtime (see `isExpiredSessionError` callers), since
 * "exited with code" also fires on unrelated SDK crashes.
 */
const EXPIRED_SESSION_ERROR_PATTERNS = [
  /exited with code/i,
  /session[\s_-]*not[\s_-]*found/i,
  /session[\s_-]*expired/i,
  /session[\s_-]*(is|was)?[\s_-]*(gone|missing|invalid)/i,
];

export interface PhaseCheckpoint {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  summary?: string;
  turnsUsed?: number;
  tokensUsed?: number;
  costUsd?: number;
  costSource?: CostSource;
  costData?: CostResolution;
  sessionRef?: string;
  sessionData?: unknown;
  usage?: RuntimeUsage;
  updatedAt: number;
}

export interface RunCheckpointState {
  runtime: RuntimeId;
  provider?: ProviderType;
  providerConfig?: ProviderConfig;
  model?: string;
  sessionRef?: string;
  sessionData?: unknown;
  phases: Record<string, PhaseCheckpoint>;
}

export function abortReasonMessage(abortController?: AbortController): string | null {
  if (!abortController?.signal.aborted) return null;
  const reason = abortController.signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.length > 0) return reason;
  return 'Agent run aborted';
}

export function isSessionResumeFailure(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return SESSION_RESUME_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Matches errors that look like "the Claude SDK session we tried to resume
 * is no longer alive." Callers MUST gate this on actually having passed a
 * `sessionRef` — otherwise an unrelated "exited with code" SDK crash would
 * be falsely classified as expired-session and the run would stop being
 * retried.
 */
export function isExpiredSessionError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return EXPIRED_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function parseCheckpointState(raw: string | null | undefined): RunCheckpointState {
  if (!raw) {
    return { runtime: 'claude-sdk', phases: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunCheckpointState>;
    return {
      runtime: parsed.runtime ?? 'claude-sdk',
      provider: parsed.provider,
      providerConfig: parsed.providerConfig,
      model: parsed.model,
      sessionRef: parsed.sessionRef,
      sessionData: parsed.sessionData,
      phases: parsed.phases ?? {},
    };
  } catch {
    return { runtime: 'claude-sdk', phases: {} };
  }
}

export function checkpointResultsForResume(
  config: EffectiveConfig,
  checkpointState: RunCheckpointState,
): PhaseResult[] {
  if (!config.phases) return [];
  const order = new Map(config.phases.map((phase, index) => [phase.name, index]));
  return Object.values(checkpointState.phases)
    .filter((phase) => phase.status === 'completed')
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    .map((phase) => buildPhaseResult({
      name: phase.name,
      status: 'completed',
      summary: phase.summary ?? '',
      turnsUsed: phase.turnsUsed,
      tokensUsed: phase.tokensUsed,
      costUsd: phase.costUsd,
      costSource: phase.costSource,
      costData: phase.costData,
      usage: phase.usage,
      sessionRef: phase.sessionRef,
    }));
}

/**
 * Construct a `PhaseResult` from whatever telemetry is available.
 *
 * Three callers hit this: (1) executePhase's success path has a full
 * `RuntimeUsage` + `CostResolution`; (2) executePhase's failure path has
 * partial telemetry attached to a `RuntimeExecutionError`; (3)
 * `checkpointResultsForResume` has pre-computed scalar fields from a
 * persisted checkpoint. Each caller passes what it has — the helper
 * derives `turnsUsed`/`tokensUsed`/`costUsd` from `usage` + `costData`
 * when available, and falls back to the direct scalar fields when not.
 */
export function buildPhaseResult(input: {
  name: string;
  status: PhaseResult['status'];
  summary: string;
  usage?: RuntimeUsage;
  costData?: CostResolution;
  turnsUsed?: number;
  tokensUsed?: number;
  costUsd?: number;
  costSource?: CostSource;
  sessionRef?: string;
  sessionData?: unknown;
}): PhaseResult & { sessionData?: unknown } {
  const {
    name, status, summary, usage, costData,
    turnsUsed, tokensUsed, costUsd, costSource,
    sessionRef, sessionData,
  } = input;
  return {
    name,
    status,
    turnsUsed: turnsUsed ?? usage?.requests ?? 0,
    tokensUsed: tokensUsed ?? usage?.totalTokens ?? 0,
    costUsd: costUsd ?? costData?.costUsd ?? 0,
    ...(costData ? { costSource: costData.source, costData } : costSource ? { costSource } : {}),
    ...(usage ? { usage } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    ...(sessionData !== undefined ? { sessionData } : {}),
    summary,
  };
}

export function serializeCheckpointState(state: RunCheckpointState): string {
  return JSON.stringify(state);
}

export function aggregateUsage(usages: Array<RuntimeUsage | undefined>): RuntimeUsage {
  const aggregate: RuntimeUsage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    durationMs: 0,
  };
  let sawCost = false;

  for (const usage of usages) {
    if (!usage) continue;
    aggregate.requests = (aggregate.requests ?? 0) + (usage.requests ?? 0);
    aggregate.inputTokens = (aggregate.inputTokens ?? 0) + (usage.inputTokens ?? 0);
    aggregate.outputTokens = (aggregate.outputTokens ?? 0) + (usage.outputTokens ?? 0);
    aggregate.totalTokens = (aggregate.totalTokens ?? 0) + (usage.totalTokens ?? 0);
    aggregate.reasoningTokens = (aggregate.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
    aggregate.cachedTokens = (aggregate.cachedTokens ?? 0) + (usage.cachedTokens ?? 0);
    aggregate.durationMs = (aggregate.durationMs ?? 0) + (usage.durationMs ?? 0);
    if (usage.costUsd !== undefined && usage.costUsd !== null) {
      aggregate.costUsd = (aggregate.costUsd ?? 0) + usage.costUsd;
      sawCost = true;
    }
  }

  if (!sawCost) {
    delete aggregate.costUsd;
  }

  return aggregate;
}

export function buildUsageData(
  runUsage: RuntimeUsage,
  runCost?: CostResolution,
  phaseResults?: PhaseResult[],
  runBudget?: RuntimeTokenBudget,
): string {
  return JSON.stringify({
    run: runUsage,
    runCost: runCost ?? null,
    runBudget: runBudget ?? null,
    phases: phaseResults?.map((phase) => ({
      name: phase.name,
      usage: phase.usage ?? null,
      turnsUsed: phase.turnsUsed,
      tokensUsed: phase.tokensUsed,
      costUsd: phase.costUsd,
      costSource: phase.costSource ?? null,
      costData: phase.costData ?? null,
    })) ?? [],
  });
}

export function buildActionsTaken(
  runtime: RuntimeId,
  provider: ProviderConfig | undefined,
  model: string,
  phaseResults?: PhaseResult[],
): string {
  return JSON.stringify({
    runtime,
    model,
    provider: provider?.type ?? 'anthropic',
    ...(provider?.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    ...(phaseResults ? { phases: phaseResults } : {}),
  });
}

export function resolveProviderForResume(
  currentProvider: ProviderConfig | undefined,
  resumedRun: {
    provider: ProviderType | null;
  } | null,
  checkpointState: RunCheckpointState,
  runtime: RuntimeId,
  model: string,
): ProviderConfig | undefined {
  const persistedType = resumedRun?.provider ?? checkpointState.provider;
  const persistedProvider = checkpointState.providerConfig;
  if (!persistedType && !persistedProvider) return currentProvider;
  const matchingCurrentProvider = currentProvider?.type === persistedType ? currentProvider : undefined;

  return {
    ...(persistedProvider ?? {}),
    ...(matchingCurrentProvider ?? {}),
    runtime,
    type: persistedType ?? persistedProvider?.type ?? currentProvider?.type ?? 'anthropic',
    model,
  };
}
