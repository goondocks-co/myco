/**
 * Per-(endpoint, scope) coalescing of in-flight scoped actions.
 *
 * Two near-simultaneous "Reconcile All Groves" clicks should fan out
 * once and both clients should see the same result — without the user
 * paying for two parallel sweeps that contend on every per-Grove DB.
 *
 * This is intentionally separate from `InflightRunRegistry` (which
 * tracks fire-and-forget agent runs for shutdown drain). Action
 * coalescing here is a request-time concern, not a shutdown concern.
 */

export class ActionInflightRegistry {
  private readonly running = new Map<string, Promise<unknown>>();

  /**
   * Run `factory` keyed by `key`. If another caller is already running
   * the same key, share that promise. The slot is released when the
   * underlying promise settles (either resolved or rejected).
   */
  run<T>(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.running.get(key);
    if (existing) return existing as Promise<T>;
    const promise = (async () => {
      try {
        return await factory();
      } finally {
        this.running.delete(key);
      }
    })();
    this.running.set(key, promise);
    return promise;
  }

  /** Number of in-flight coalesced actions. */
  get size(): number {
    return this.running.size;
  }

  has(key: string): boolean {
    return this.running.has(key);
  }
}
