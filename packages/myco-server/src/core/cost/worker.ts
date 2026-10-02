import type { ExecutionIdentity, WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { buildTokenBreakdown } from './breakdown.js';
import { resolveCost } from './resolver.js';
import { resolveUnavailableCost } from './helpers.js';
import type { CostResolution, CostResolutionInput, RunUsage } from './types.js';

/** Dollar evidence is usable even when token evidence covers only part of a run. */
function counts(usage: WorkerUsage | null): RunUsage {
  return usage === null ? {} : Object.fromEntries(Object.entries(usage).filter(([key, value]) =>
    typeof value === 'number' && (usage.tokenScope === undefined || key === 'costUsd' || key === 'estimatedCostUsd')));
}

function complete(usage: WorkerUsage | null): boolean {
  return usage !== null && usage.tokenScope === undefined && usage.inputTokens !== null && usage.outputTokens !== null
    && usage.cachedTokens != null && usage.cachedTokens <= usage.inputTokens && usage.cachedTokens + (usage.cacheCreationTokens ?? 0) <= usage.inputTokens;
}

/** Resolve each reported model independently; a total is available only when every contribution is available. */
export async function resolveWorkerCost(harness: string, usage: WorkerUsage | null, identity?: ExecutionIdentity): Promise<CostResolution> {
  const primary = identity === undefined || identity.status === 'unknown' ? null : identity.primary;
  const input: CostResolutionInput = { harness, model: primary?.model ?? '', provider: primary?.provider === undefined ? undefined : { type: primary.provider }, usage: counts(usage), context: primary?.context };
  const models = identity === undefined || identity.status === 'unknown' ? [] : await Promise.all(identity.models.map(async (model) => {
    const modelInput = { harness, model: model.model, provider: model.provider === undefined ? undefined : { type: model.provider }, usage: counts(model.usage), context: model.context };
    const dollars = model.usage?.costUsd != null || model.usage?.estimatedCostUsd != null;
    const cost = dollars || (identity.status === 'reported' && complete(model.usage))
      ? await resolveCost(modelInput) : resolveUnavailableCost(modelInput, 'Complete reported model accounting is unavailable');
    return { model: model.model, provider: model.provider ?? null, identitySource: model.source, ...cost, provenance: cost.provenance ?? 'unavailable' as const };
  }));
  if (usage?.costUsd != null || usage?.estimatedCostUsd != null) return { ...await resolveCost(input), models };
  if (models.length === 0 || models.some((m) => m.costUsd === null) || (identity?.status !== 'unknown' && identity?.warnings?.length)) return {
    ...resolveUnavailableCost(input, 'Model identity, complete counts or exact pricing is unavailable'), provenance: 'unavailable', models,
  };
  const sum = models.reduce((total, model) => total + model.costUsd!, 0);
  const allActual = models.every((m) => m.source === 'actual');
  return {
    source: allActual ? 'actual' : 'estimated', costUsd: sum,
    actualCostUsd: allActual ? sum : null, estimatedCostUsd: allActual ? null : sum,
    provenance: new Set(models.map((m) => m.provenance)).size > 1 ? 'mixed' : models[0]!.provenance,
    breakdown: { ...buildTokenBreakdown(counts(usage)), totalCostUsd: sum }, models,
  };
}
