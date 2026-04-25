import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for the per-session Canopy aggregate (60 seconds). */
const SESSION_CANOPY_STALE_TIME = 60_000;

/** Cache TTL for the lifetime Canopy rollup (5 minutes — moves slowly). */
const ROLLUP_STALE_TIME = 300_000;

/** Cache TTL for an injection-blob fetch (effectively immutable per tool-call). */
const BLOB_STALE_TIME = 3_600_000;

/* ---------- Types ---------- */

/**
 * Per-session Canopy aggregates returned by `GET /sessions/:id/canopy`.
 *
 * Mirrors the canopy_* columns on the session row (Phase 0 schema).
 * All numeric fields are nullable to cover pre-feature sessions, sessions
 * where the feature is disabled in the active scope, and sessions whose
 * Stop hook hasn't materialized aggregates yet.
 */
export interface SessionCanopyAggregate {
  canopy_injections_offered: number | null;
  canopy_injection_total_tokens: number | null;
  canopy_skips_after_injection: number | null;
  canopy_reads_after_injection: number | null;
  canopy_tokens_saved: number | null;
  canopy_redundant_reads: number | null;
}

/**
 * Lifetime Canopy rollup returned by `GET /canopy/rollup`.
 *
 * Aggregated across all sessions on this machine. NULLs indicate "no data
 * yet" — the rollup endpoint may also return an entirely null payload for a
 * fresh project, in which case the consumer should hide the rollup tile.
 */
export interface CanopyRollup {
  total_tokens_saved: number | null;
  sessions_with_canopy: number | null;
  avg_tokens_saved_per_session: number | null;
  total_injections_offered: number | null;
  total_skips_after_injection: number | null;
  injection_effectiveness_ratio: number | null;
}

/**
 * Verbatim injection blob persisted with a tool-call row. The shape is the
 * structural payload Cortex composed at PreToolUse — `summary` is populated
 * only when a Tier 2 `llm_description` was available.
 */
export interface CanopyInjectionBlob {
  path: string;
  tokenEstimate: number;
  lineCount: number;
  exports: string[];
  imports: string[];
  top: string | null;
  summary: string | null;
}

/* ---------- Helpers ---------- */

/**
 * Treat 404 as "no data" rather than an error. Used for endpoints Track C
 * may not have shipped yet, plus pre-feature sessions where no row exists.
 * Re-throws every other error so React Query can surface real failures.
 */
async function fetchJsonOrNullOn404<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    return await fetchJson<T>(path, { signal });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * True when every numeric field in the aggregate is null. The session detail
 * tile uses this as its hide-gracefully signal: pre-feature sessions and
 * sessions captured under disabled-injection scope both produce all-null
 * payloads (the row exists but has no Canopy outcomes to report).
 */
export function isCanopyAggregateEmpty(agg: SessionCanopyAggregate | null | undefined): boolean {
  if (!agg) return true;
  return (
    agg.canopy_injections_offered === null
    && agg.canopy_injection_total_tokens === null
    && agg.canopy_skips_after_injection === null
    && agg.canopy_reads_after_injection === null
    && agg.canopy_tokens_saved === null
    && agg.canopy_redundant_reads === null
  );
}

/** Same hide-gracefully test for the lifetime rollup. */
export function isCanopyRollupEmpty(rollup: CanopyRollup | null | undefined): boolean {
  if (!rollup) return true;
  return (
    rollup.total_tokens_saved === null
    && rollup.sessions_with_canopy === null
    && rollup.avg_tokens_saved_per_session === null
    && rollup.total_injections_offered === null
    && rollup.total_skips_after_injection === null
    && rollup.injection_effectiveness_ratio === null
  );
}

/* ---------- Hooks ---------- */

/**
 * Fetches per-session Canopy aggregates. Returns `null` (not an error) when
 * the endpoint 404s, so callers can hide the tile entirely without branching
 * on the error path. Track C's `/sessions/:id/canopy` route may not exist on
 * every branch — graceful 404 handling lets the UI ship ahead of the API.
 */
export function useSessionCanopy(sessionId: string | undefined) {
  return useQuery<SessionCanopyAggregate | null>({
    queryKey: ['session-canopy', sessionId],
    queryFn: ({ signal }) =>
      fetchJsonOrNullOn404<SessionCanopyAggregate>(`/sessions/${sessionId}/canopy`, signal),
    enabled: sessionId !== undefined,
    staleTime: SESSION_CANOPY_STALE_TIME,
    // Don't retry 404s — they're a "no data" answer, not a transient failure.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });
}

/** Fetches the lifetime Canopy rollup for the all-sessions surface. */
export function useCanopyRollup() {
  return useQuery<CanopyRollup | null>({
    queryKey: ['canopy-rollup'],
    queryFn: ({ signal }) =>
      fetchJsonOrNullOn404<CanopyRollup>('/canopy/rollup', signal),
    staleTime: ROLLUP_STALE_TIME,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });
}

/**
 * Fetches the verbatim injection blob persisted with a tool-call row.
 * Lazy — only runs when both ids are defined (the indicator passes
 * `undefined` until the user opens its popover).
 */
export function useCanopyInjectionBlob(
  sessionId: string | undefined,
  toolCallId: number | undefined,
) {
  return useQuery<CanopyInjectionBlob | null>({
    queryKey: ['canopy-tool-call-blob', sessionId, toolCallId],
    queryFn: ({ signal }) =>
      fetchJsonOrNullOn404<CanopyInjectionBlob>(
        `/sessions/${sessionId}/canopy/tool-calls/${toolCallId}/blob`,
        signal,
      ),
    enabled: sessionId !== undefined && toolCallId !== undefined,
    staleTime: BLOB_STALE_TIME,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
