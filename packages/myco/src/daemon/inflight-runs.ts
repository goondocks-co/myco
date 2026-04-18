/**
 * Registry that tracks in-flight fire-and-forget agent runs so daemon
 * shutdown can wait for them to settle.
 *
 * Without this, SIGTERM/SIGINT abandons any cortex-instructions or
 * cortex-prompt-builder run launched via `runAgent()` fire-and-forget —
 * leaving non-terminal rows in `agent_runs` and, on reasoning-heavy
 * providers, real money on the table.
 */

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export class InflightRunRegistry {
  private readonly runs = new Set<Promise<unknown>>();

  /**
   * Track a fire-and-forget agent run. The promise is removed from the
   * registry in a finally handler so a resolved/rejected run does not hold
   * memory. Resolves immediately — callers must not await this directly.
   */
  register(promise: Promise<unknown>): void {
    const tracked = Promise.resolve(promise).finally(() => {
      this.runs.delete(tracked);
    });
    this.runs.add(tracked);
  }

  /** Number of runs currently being tracked. */
  get size(): number {
    return this.runs.size;
  }

  /**
   * Wait for every tracked run to settle, up to `timeoutMs`. Returns when
   * either every run completes or the deadline elapses — whichever happens
   * first. The 30-second default mirrors a typical daemon shutdown budget;
   * callers are free to override for tests or tighter environments.
   */
  async drain(timeoutMs: number = DEFAULT_DRAIN_TIMEOUT_MS): Promise<{ settled: boolean; remaining: number }> {
    if (this.runs.size === 0) return { settled: true, remaining: 0 };

    const snapshot = Array.from(this.runs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const allSettled = Promise.allSettled(snapshot).then(() => 'settled' as const);

    try {
      const outcome = await Promise.race([allSettled, timeoutPromise]);
      return { settled: outcome === 'settled', remaining: this.runs.size };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
