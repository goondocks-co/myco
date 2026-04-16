import type { RunUpdate } from '@myco/db/queries/runs.js';
import type { CostResolution } from './cost/types.js';
import {
  buildActionsTaken,
  buildUsageData,
  serializeCheckpointState,
  type RunCheckpointState,
} from './executor-state.js';
import type { PhaseResult, ProviderConfig, RuntimeId, RuntimeUsage } from './types.js';

export function serializeCostData(cost: CostResolution | undefined): string | null {
  return cost ? JSON.stringify(cost) : null;
}

export function summarizePhaseCosts(phaseResults: PhaseResult[]): CostResolution {
  const costedPhases = phaseResults.filter((phase) => phase.costData && phase.costData.costUsd !== null);
  if (costedPhases.length === 0) {
    return {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      breakdown: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        requestCount: 0,
      },
      pricingVersion: null,
      message: 'No phase cost data available',
    };
  }

  const firstCost = costedPhases[0].costData!;
  const aggregate = {
    costUsd: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    breakdown: {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requestCount: 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      reasoningCostUsd: 0,
      requestCostUsd: 0,
      cacheSavingsUsd: 0,
      totalCostUsd: 0,
    },
  };

  for (const phase of costedPhases) {
    const cost = phase.costData!;
    const breakdown = cost.breakdown;
    aggregate.costUsd += cost.costUsd ?? 0;
    aggregate.actualCostUsd += cost.actualCostUsd ?? 0;
    aggregate.estimatedCostUsd += cost.estimatedCostUsd ?? 0;
    aggregate.breakdown.inputTokens += breakdown.inputTokens;
    aggregate.breakdown.cachedInputTokens += breakdown.cachedInputTokens;
    aggregate.breakdown.uncachedInputTokens += breakdown.uncachedInputTokens;
    aggregate.breakdown.outputTokens += breakdown.outputTokens;
    aggregate.breakdown.reasoningTokens += breakdown.reasoningTokens;
    aggregate.breakdown.requestCount += breakdown.requestCount;
    aggregate.breakdown.inputCostUsd += breakdown.inputCostUsd ?? 0;
    aggregate.breakdown.cachedInputCostUsd += breakdown.cachedInputCostUsd ?? 0;
    aggregate.breakdown.outputCostUsd += breakdown.outputCostUsd ?? 0;
    aggregate.breakdown.reasoningCostUsd += breakdown.reasoningCostUsd ?? 0;
    aggregate.breakdown.requestCostUsd += breakdown.requestCostUsd ?? 0;
    aggregate.breakdown.cacheSavingsUsd += breakdown.cacheSavingsUsd ?? 0;
  }
  aggregate.breakdown.totalCostUsd = aggregate.costUsd;

  const allActual = phaseResults.every((phase) => phase.costData?.source === 'actual');
  const hasUnavailable = phaseResults.some((phase) => phase.costData?.source === 'unavailable');
  return {
    source: allActual ? 'actual' : 'estimated',
    costUsd: aggregate.costUsd,
    actualCostUsd: allActual ? aggregate.actualCostUsd : null,
    estimatedCostUsd: allActual ? null : aggregate.costUsd,
    breakdown: aggregate.breakdown,
    pricingVersion: costedPhases.every((phase) => phase.costData?.pricingVersion === firstCost.pricingVersion)
      ? firstCost.pricingVersion ?? null
      : null,
    ...(hasUnavailable ? { message: 'Some phase costs were unavailable; total reflects known phase costs only' } : {}),
  };
}

interface RunAccountingUpdateInput {
  runtime: RuntimeId;
  provider?: ProviderConfig;
  model: string;
  checkpointState: RunCheckpointState;
  usage: RuntimeUsage;
  costData: CostResolution;
  phaseResults?: PhaseResult[];
  sessionRef?: string | null;
}

interface RunAccountingUpdateFields extends Pick<
  RunUpdate,
  | 'runtime'
  | 'provider'
  | 'model'
  | 'session_ref'
  | 'checkpoints'
  | 'usage_data'
  | 'cost_usd'
  | 'actual_cost_usd'
  | 'estimated_cost_usd'
  | 'cost_source'
  | 'cost_data'
> {
  actions_taken: string;
}

export function buildRunAccountingUpdate(input: RunAccountingUpdateInput): RunAccountingUpdateFields {
  return {
    runtime: input.runtime,
    provider: input.provider?.type ?? null,
    model: input.model,
    session_ref: input.sessionRef ?? input.checkpointState.sessionRef ?? null,
    checkpoints: serializeCheckpointState(input.checkpointState),
    usage_data: buildUsageData(input.usage, input.costData, input.phaseResults),
    cost_usd: input.costData.costUsd ?? null,
    actual_cost_usd: input.costData.actualCostUsd,
    estimated_cost_usd: input.costData.estimatedCostUsd,
    cost_source: input.costData.source,
    cost_data: serializeCostData(input.costData),
    actions_taken: buildActionsTaken(input.runtime, input.provider, input.model, input.phaseResults),
  };
}
