import type { WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import { numberOf, recordOf } from './stream.js';

/** An absent component leaves a total unknown. */
function total(values: Array<number | null>): number | null {
  return values.length === 0 || values.some((value) => value === null)
    ? null : values.reduce<number>((sum, value) => sum + value!, 0);
}

/** Query-wide model totals include cached input and calls outside Claude's main loop. */
export function claudeUsage(line: Record<string, unknown>): WorkerUsage {
  const models = recordOf(line.modelUsage);
  const rows = models === null ? [] : Object.values(models).map(recordOf);
  const sum = (key: string) => total(rows.map((row) => numberOf(row?.[key])));
  const usage = recordOf(line.usage);
  const cachedTokens = rows.length > 0 ? sum('cacheReadInputTokens') : numberOf(usage?.cache_read_input_tokens);
  const cacheCreationTokens = rows.length > 0 ? sum('cacheCreationInputTokens') : numberOf(usage?.cache_creation_input_tokens);
  const fresh = rows.length > 0 ? sum('inputTokens') : numberOf(usage?.input_tokens);
  return {
    inputTokens: total([fresh, cachedTokens, cacheCreationTokens]),
    outputTokens: rows.length > 0 ? sum('outputTokens') : numberOf(usage?.output_tokens),
    cachedTokens,
    cacheCreationTokens,
    costUsd: null,
    estimatedCostUsd: numberOf(line.total_cost_usd),
  };
}
