/**
 * Shared traversal helper for executionOverrides provider fields.
 *
 * Two call sites need to walk the override shape and transform each provider
 * object (top-level and per-phase):
 *
 *   - `sanitizeExecutionOverrides` (inbound, agent-runs.ts) strips
 *     `baseUrl` from remote-provider overrides on request entry.
 *   - `scrubExecutionOverrides` (outbound, run-serializer.ts) strips
 *     `apiKey` from historical rows during serialization.
 *
 * Keeping the traversal itself in one place means adding a future override
 * field (e.g. `headers`) is a one-line change per transform, not a
 * structural rewrite of two separate walkers that could drift.
 *
 * The helper always returns a fresh top-level object and never mutates its
 * input; clones are shallow because the override shape is JSON-column data
 * with a known, finite schema.
 */

export type ProviderTransform = (
  provider: Record<string, unknown>,
) => Record<string, unknown> | null;

/**
 * Apply `transform` to every provider object inside an executionOverrides
 * blob: the top-level `provider` and every `phases[name].provider`.
 *
 * If `transform` returns `null` for a given provider, that `provider` field
 * is removed from its containing object entirely.
 *
 * `null`/`undefined` input passes through unchanged (returned as `null`
 * when input is `null`, preserving the caller's nullable contract).
 */
export function transformProviderOverrides(
  overrides: Record<string, unknown> | null | undefined,
  transform: ProviderTransform,
): Record<string, unknown> | null {
  if (overrides === null || overrides === undefined) {
    return overrides ?? null;
  }
  if (typeof overrides !== 'object') return overrides as never;

  const cloned: Record<string, unknown> = { ...overrides };

  if (isPlainObject(cloned.provider)) {
    const next = transform({ ...cloned.provider });
    if (next === null) {
      delete cloned.provider;
    } else {
      cloned.provider = next;
    }
  }

  if (isPlainObject(cloned.phases)) {
    const nextPhases: Record<string, unknown> = {};
    for (const [name, phase] of Object.entries(cloned.phases)) {
      if (!isPlainObject(phase)) {
        nextPhases[name] = phase;
        continue;
      }
      const clonedPhase: Record<string, unknown> = { ...phase };
      if (isPlainObject(clonedPhase.provider)) {
        const nextProvider = transform({ ...clonedPhase.provider });
        if (nextProvider === null) {
          delete clonedPhase.provider;
        } else {
          clonedPhase.provider = nextProvider;
        }
      }
      nextPhases[name] = clonedPhase;
    }
    cloned.phases = nextPhases;
  }

  return cloned;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
