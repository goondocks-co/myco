import type { WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { harnessById } from '../harnesses.js';
import { reportedDollars, reportedModel } from '../accounting.js';
import { numberOf, recordOf } from './stream.js';

/** An absent component leaves a total unknown. */
function total(values: Array<number | null>): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Query-wide model totals include cached input and calls outside Claude's main loop. */
export function claudeUsage(line: Record<string, unknown>, options: { environment?: Record<string, string | undefined>; primaryModel?: string; cacheWrites?: ReadonlyMap<string, { cacheCreation5mTokens: number; cacheCreation1hTokens: number }> } = {}): WorkerUsage {
  const harness = harnessById('claude-code')!;
  const models = recordOf(line.modelUsage);
  const rows = models === null ? [] : Object.values(models).map(recordOf);
  const sum = (key: string) => total(rows.map((row) => numberOf(row?.[key])));
  const usage = recordOf(line.usage);
  const cachedTokens = rows.length > 0 ? sum('cacheReadInputTokens') : numberOf(usage?.cache_read_input_tokens);
  const cacheCreationTokens = rows.length > 0 ? sum('cacheCreationInputTokens') : numberOf(usage?.cache_creation_input_tokens);
  const fresh = rows.length > 0 ? sum('inputTokens') : numberOf(usage?.input_tokens);
  const perModel = models === null ? [] : Object.entries(models).map(([model, value]) => {
    const row = recordOf(value);
    return reportedModel(harness, model, 'result.modelUsage', {
      inputTokens: total([numberOf(row?.inputTokens), numberOf(row?.cacheReadInputTokens), numberOf(row?.cacheCreationInputTokens)]),
      outputTokens: numberOf(row?.outputTokens), cachedTokens: numberOf(row?.cacheReadInputTokens),
      cacheCreationTokens: numberOf(row?.cacheCreationInputTokens), costUsd: null, estimatedCostUsd: reportedDollars(harness.accounting, numberOf(row?.costUSD)),
    }, undefined, options.environment);
  });
  const merged = new Map<string, typeof perModel[number]>();
  for (const model of perModel) {
    const prior = merged.get(model.model);
    if (prior === undefined) merged.set(model.model, model);
    else {
      const combined = Object.fromEntries(Object.keys(model.usage!).map((key) => [key, total([prior.usage![key as keyof Omit<WorkerUsage, 'models'>] as number | null, model.usage![key as keyof Omit<WorkerUsage, 'models'>] as number | null])]));
      merged.set(model.model, { ...prior, ...model, usage: { inputTokens: combined.inputTokens ?? null, outputTokens: combined.outputTokens ?? null, costUsd: combined.costUsd ?? null, cachedTokens: combined.cachedTokens ?? null, cacheCreationTokens: combined.cacheCreationTokens ?? null, estimatedCostUsd: combined.estimatedCostUsd ?? null } });
    }
  }
  const cache = recordOf(usage?.cache_creation);
  for (const model of merged.values()) {
    const fromMessages = options.cacheWrites?.get(model.model);
    const fromResult = merged.size === 1 || model.model === options.primaryModel ? { cacheCreation5mTokens: numberOf(cache?.ephemeral_5m_input_tokens), cacheCreation1hTokens: numberOf(cache?.ephemeral_1h_input_tokens) } : undefined;
    const writes = fromResult?.cacheCreation5mTokens != null && fromResult.cacheCreation1hTokens != null ? fromResult : fromMessages;
    if (writes?.cacheCreation5mTokens != null && writes.cacheCreation1hTokens != null && writes.cacheCreation5mTokens + writes.cacheCreation1hTokens === model.usage?.cacheCreationTokens) {
      model.usage = { ...model.usage, cacheCreation5mTokens: writes.cacheCreation5mTokens, cacheCreation1hTokens: writes.cacheCreation1hTokens };
    }
  }
  return {
    ...(merged.size === 0 ? {} : { models: [...merged.values()] }),
    inputTokens: total([fresh, cachedTokens, cacheCreationTokens]),
    outputTokens: rows.length > 0 ? sum('outputTokens') : numberOf(usage?.output_tokens),
    cachedTokens,
    cacheCreationTokens,
    costUsd: null,
    estimatedCostUsd: reportedDollars(harness.accounting, numberOf(line.total_cost_usd)),
  };
}
