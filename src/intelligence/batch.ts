/**
 * Batch execution utilities for LLM and embedding operations.
 *
 * Provides concurrency-limited parallel execution for bulk operations
 * like reprocessing, rebuilding, and any future batch pipeline.
 */

/** Default concurrency for LLM calls (heavier, single-threaded backends). */
export const LLM_BATCH_CONCURRENCY = 3;
/** Default concurrency for embedding calls (lighter, can run more in parallel). */
export const EMBEDDING_BATCH_CONCURRENCY = 4;

export interface BatchResult<T> {
  succeeded: number;
  failed: number;
  results: Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: string }>;
}

/**
 * Execute async tasks with a concurrency limit.
 * Reports progress via an optional callback.
 */
export async function batchExecute<I, O>(
  items: I[],
  fn: (item: I) => Promise<O>,
  options: {
    concurrency: number;
    onProgress?: (completed: number, total: number) => void;
  },
): Promise<BatchResult<O>> {
  const { concurrency, onProgress } = options;
  let succeeded = 0;
  let failed = 0;
  const results: BatchResult<O>['results'] = [];

  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(fn));

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        succeeded++;
        results.push({ status: 'fulfilled', value: result.value });
      } else {
        failed++;
        results.push({ status: 'rejected', reason: (result.reason as Error)?.message ?? String(result.reason) });
      }
    }

    onProgress?.(succeeded + failed, items.length);
  }

  return { succeeded, failed, results };
}
