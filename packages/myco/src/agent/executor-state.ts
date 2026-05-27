import type { CostResolution, CostSource } from './cost/types.js';
import type {
  EffectiveConfig,
  PhaseResult,
  ProviderConfig,
  ProviderType,
  HarnessId,
  RuntimeTokenBudget,
  RuntimeUsage,
} from './types.js';
import { HARNESS_CLAUDE_SDK } from './types.js';

export interface PhaseCheckpoint {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
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
  /** Set when the phase failed because the SDK hit the turn budget. */
  capHit?: boolean;
  /** The maxTurns budget the SDK enforced for this phase (post-overrides). */
  allowedMaxTurns?: number;
}

export interface RunCheckpointState {
  schemaVersion: 2;
  harness: HarnessId;
  provider?: ProviderType;
  providerConfig?: ProviderConfig;
  model?: string;
  harnessState?: {
    ref?: string;
    data?: unknown;
  };
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

export function parseCheckpointState(raw: string | null | undefined): RunCheckpointState {
  if (!raw) {
    return { schemaVersion: 2, harness: HARNESS_CLAUDE_SDK, phases: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<RunCheckpointState> & { harness?: HarnessId };
    const harnessState = parsed.harnessState ?? {
      ...(parsed.sessionRef ? { ref: parsed.sessionRef } : {}),
      ...(parsed.sessionData !== undefined ? { data: parsed.sessionData } : {}),
    };
    return {
      schemaVersion: 2,
      harness: parsed.harness ?? parsed.harness ?? HARNESS_CLAUDE_SDK,
      provider: parsed.provider,
      providerConfig: parsed.providerConfig,
      model: parsed.model,
      ...(Object.keys(harnessState).length > 0 ? { harnessState } : {}),
      sessionRef: parsed.sessionRef ?? harnessState.ref,
      sessionData: parsed.sessionData ?? harnessState.data,
      phases: parsed.phases ?? {},
    };
  } catch {
    return { schemaVersion: 2, harness: HARNESS_CLAUDE_SDK, phases: {} };
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
 * partial telemetry attached to a `HarnessExecutionError`; (3)
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
  capHit?: boolean;
  allowedMaxTurns?: number;
}): PhaseResult & { sessionData?: unknown } {
  const {
    name, status, summary, usage, costData,
    turnsUsed, tokensUsed, costUsd, costSource,
    sessionRef, sessionData, capHit, allowedMaxTurns,
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
    ...(capHit === true ? { capHit: true } : {}),
    ...(allowedMaxTurns !== undefined ? { allowedMaxTurns } : {}),
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
  harness: HarnessId,
  provider: ProviderConfig | undefined,
  model: string,
  phaseResults?: PhaseResult[],
): string {
  return JSON.stringify({
    harness,
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
  model: string,
): ProviderConfig | undefined {
  const persistedType = resumedRun?.provider ?? checkpointState.provider;
  const persistedProvider = checkpointState.providerConfig;
  if (!persistedType && !persistedProvider) return currentProvider;
  const matchingCurrentProvider = currentProvider?.type === persistedType ? currentProvider : undefined;

  return {
    ...(persistedProvider ?? {}),
    ...(matchingCurrentProvider ?? {}),
    type: persistedType ?? persistedProvider?.type ?? currentProvider?.type ?? 'anthropic',
    model,
  };
}
