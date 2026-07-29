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
  /**
   * Set when the phase failed because `snapshotFlaggedWrites` converted an
   * otherwise-"completed" result to "failed" (a semantic-check block —
   * see phase-loop.ts). Distinct from a hard runtime failure: the phase DID
   * produce turns (so the zero-turns "poisoned session" exclusion below
   * doesn't catch it), but the session's conversation history contains the
   * model's own blocked tool call. Reusing that session on resume would let
   * the model retry the identical call against a fresh accumulator and
   * fresh verdict cache, defeating the semantic check. See the
   * `reuseSession` exclusion in phase-loop.ts.
   */
  semanticCheckBlocked?: boolean;
  /**
   * Set when the phase failed because an unsatisfied
   * `PhaseDefinition.postCondition` converted an otherwise-"completed"
   * result to "failed" (see phase-loop.ts). Same session-reuse hazard as
   * `semanticCheckBlocked` above: the phase produced turns, but the
   * session history is the model's own non-compliant completion —
   * reattaching on resume invites the model to reaffirm it. See the
   * `reuseSession` exclusion in phase-loop.ts.
   */
  postConditionFailed?: boolean;
  /**
   * Metadata emitted by the phase via `phase_emit_metadata`. Persisted
   * so a resumed run preserves the same gate decisions for downstream
   * phases — gates evaluate against this checkpoint, not against a
   * re-execution of the upstream phase.
   */
  metadata?: Record<string, unknown>;
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
  // Resume preserves BOTH completed and skipped phases as decisions.
  // Re-evaluating a skipped phase on resume would let intervening state
  // change (e.g. embeddings settling, new spores) flip the gate, producing
  // a different downstream context than the original attempt — breaking
  // the invariant that a resumed run completes the same work the first
  // attempt started.
  return Object.values(checkpointState.phases)
    .filter((phase) => phase.status === 'completed' || phase.status === 'skipped')
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    .map((phase) => buildPhaseResult({
      name: phase.name,
      status: phase.status === 'skipped' ? 'skipped' : 'completed',
      summary: phase.summary ?? '',
      turnsUsed: phase.turnsUsed,
      tokensUsed: phase.tokensUsed,
      costUsd: phase.costUsd,
      costSource: phase.costSource,
      costData: phase.costData,
      usage: phase.usage,
      sessionRef: phase.sessionRef,
      metadata: phase.metadata,
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
  errorKind?: PhaseResult['errorKind'];
  allowedMaxTurns?: number;
  metadata?: Record<string, unknown>;
  semanticCheckBlocked?: boolean;
  postConditionFailed?: boolean;
}): PhaseResult & { sessionData?: unknown } {
  const {
    name, status, summary, usage, costData,
    turnsUsed, tokensUsed, costUsd, costSource,
    sessionRef, sessionData, capHit, errorKind, allowedMaxTurns, metadata, semanticCheckBlocked,
    postConditionFailed,
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
    ...(errorKind !== undefined ? { errorKind } : {}),
    ...(semanticCheckBlocked === true ? { semanticCheckBlocked: true } : {}),
    ...(postConditionFailed === true ? { postConditionFailed: true } : {}),
    ...(allowedMaxTurns !== undefined ? { allowedMaxTurns } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
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
  // Concatenated (not summed) across phases/items — each entry is still a
  // single request's own usage, so `analyzeRuntimeTokenBudget`'s
  // peak-over-entries can find the true per-request peak across the whole
  // run instead of only the last phase's entries (which is what a naive
  // overwrite would leave behind).
  const requestUsageEntries: Array<Record<string, unknown>> = [];

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
    if (usage.requestUsageEntries && usage.requestUsageEntries.length > 0) {
      requestUsageEntries.push(...usage.requestUsageEntries);
    }
  }

  if (!sawCost) {
    delete aggregate.costUsd;
  }
  if (requestUsageEntries.length > 0) {
    aggregate.requestUsageEntries = requestUsageEntries;
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

  // Snapshot invariant: for a same-type resume, the PERSISTED provider
  // snapshot wins over live config for every overlapping field. Live config
  // (matchingCurrentProvider) is only a fallback base for fields the
  // snapshot never captured. Spreading live config last would let an
  // operator's myco.yaml edit between dispatch and resume silently rewrite
  // audit-bearing fields (actions_taken.baseUrl, the token-budget
  // contextLength) to values the original run never used.
  return {
    ...(matchingCurrentProvider ?? {}),
    ...(persistedProvider ?? {}),
    type: persistedType ?? persistedProvider?.type ?? currentProvider?.type ?? 'anthropic',
    model,
  };
}
