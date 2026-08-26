/**
 * PROPOSAL, not contract.
 *
 * These are the adapters the server will need and does not have. They are kept out
 * of `ServerEnv` deliberately: nothing implements them, nothing consumes them, and
 * a signature written before its consumer exists is a guess that reads as settled.
 * Each will be designed WITH the issue that needs it, against a real query:
 *
 *   VectorStore       #913 / #914 implement, #921 recall states the query it needs
 *   WakeScheduler     #913 / #914 implement, #919 states what must run and when
 *   HarnessDispatcher #913 / #914 implement, gated on the #908 container spike;
 *                     #919 requires resumability, cancellation, and failure records
 *   TelemetrySink     #913 / #914; `emit()` writing to the console is correct on
 *                     both targets today
 *
 * One EXISTING adapter will also change shape: `RelationalStore` has no
 * multi-statement `exec`, so #913's migrations-on-start has no path through it.
 * It is not widened here while no shared code needs it — applying migration files
 * is a platform concern today, and a contract method with no caller is the same
 * guess as the interfaces below.
 *
 * The rule they must follow, which is the part worth fixing early: a signature
 * names product vocabulary and never a platform primitive, so neither target can
 * force its own infrastructure into the shared contract. Anything holding a
 * resource handle rides `ServerEnv`; a per-deployment pure function rides
 * `ServerDeps`.
 */

export interface VectorMatch {
  id: string;
  score: number;
}

/** Vector storage, implemented per target in #913 and #914. Consumed by recall and search in #919/#921. */
export interface VectorStore {
  upsert(vectors: Array<{ id: string; values: number[]; projectId: string }>): Promise<void>;
  query(values: number[], options: { projectId: string; topK: number }): Promise<VectorMatch[]>;
  delete(ids: string[]): Promise<void>;
}

/**
 * Deferred wake, implemented per target in #913 and #914.
 *
 * The shape is still a proposal — #919 states what must run and when — but the
 * division it serves is settled: the power manager owns every scheduling decision,
 * resolving a state from registered assertions and computing an interval from it,
 * and a target supplies only "wake me at this instant". Nothing about which states
 * exist, when to run, or how often belongs behind this port.
 *
 * Whatever signature #919 settles on, a wake may arrive more than once on some
 * targets, so acting on one must be idempotent. The power manager already is — it
 * re-probes its sources and recomputes rather than accumulating — and that
 * property has to stay gated rather than assumed.
 *
 * `docs/architecture/myco-2.0.md` §7.5 carries the per-target mechanisms.
 */
export interface WakeScheduler {
  scheduleAt(key: string, epochMs: number): Promise<void>;
  cancel(key: string): Promise<void>;
}

/** Dispatch of an intelligence run to the harness container, implemented per target in #913 and #914, one of which is gated on the #908 spike. */
export interface HarnessDispatcher {
  dispatch(job: { projectId: string; task: string; payload: Record<string, unknown> }): Promise<{ runId: string }>;
}

/**
 * A stand-in for an adapter a deployment has not configured. It throws by name on
 * use rather than returning a silent no-op: an unconfigured capability must be a
 * loud failure, never data quietly going nowhere.
 */
export function notConfigured<T extends object>(adapter: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      // Properties the runtime looks up implicitly are left undefined. Trapping
      // them makes an `await` of the object throw, makes it masquerade as a
      // thenable, and makes `JSON.stringify` throw — which would defeat the
      // last-resort error handler that serialises what it is given.
      if (prop === 'then' || prop === 'toJSON' || prop === 'toString' || prop === 'inspect' || typeof prop === 'symbol') return undefined;
      return () => {
        throw new Error(`${adapter} adapter is not configured on this deployment (called ${String(prop)})`);
      };
    },
  });
}

