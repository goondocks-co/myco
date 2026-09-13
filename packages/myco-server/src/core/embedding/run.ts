export const EMBEDDING_RUN_STEPS = 16;
const CLOSE_RESERVE_MS = 45_000;

export function embeddingRunReport(result: { processed: number; phase: string }) {
  return { action: 'embedding', summary: `Processed ${result.processed} embedding records; ${result.phase}.`, details: JSON.stringify(result) };
}

/** Advance bounded embedding steps while retaining time to close the run. */
export async function runEmbeddingSteps(step: () => Promise<Record<string, unknown>>, signal: AbortSignal, deadline: number): Promise<{ processed: number; phase: string }> {
  let processed = 0;
  let phase = 'pending';
  for (let iteration = 0; iteration < EMBEDDING_RUN_STEPS && Date.now() + CLOSE_RESERVE_MS < deadline; iteration++) {
    signal.throwIfAborted();
    const result = await step();
    if (result.held !== true) throw new Error('embedding run no longer holds its index');
    if (result.provider_unavailable === true) throw new Error('embedding provider is unavailable');
    if (typeof result.phase !== 'string' || typeof result.processed !== 'number') throw new Error('embedding step returned an invalid result');
    phase = result.phase;
    processed += result.processed;
    if (result.processed === 0) break;
  }
  signal.throwIfAborted();
  return { processed, phase };
}
