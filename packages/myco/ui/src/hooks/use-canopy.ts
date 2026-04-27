import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, postJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for the per-session Canopy aggregate (60 seconds). */
const SESSION_CANOPY_STALE_TIME = 60_000;

/** Cache TTL for the lifetime Canopy rollup (5 minutes — moves slowly). */
const ROLLUP_STALE_TIME = 300_000;

/** Cache TTL for an injection-blob fetch (effectively immutable per tool-call). */
const BLOB_STALE_TIME = 3_600_000;

/** Cache TTL for the canopy entries list/detail (30 seconds). */
const ENTRIES_STALE_TIME = 30_000;

/* ---------- Types ---------- */

/**
 * Per-session Canopy aggregates returned by `GET /sessions/:id/canopy`.
 *
 * Mirrors the canopy_* columns on the session row.
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
 * Verbatim injection blob for a tool-call row. The wire shape is just the
 * pre-rendered string Cortex would compose for the live row right now —
 * single source of truth with the agent's PreToolUse path, including the
 * freshness gate, item caps, and the 800-char overall cap.
 */
export interface CanopyInjectionBlob {
  blob: string;
}

/* ---------- Helpers ---------- */

/**
 * Treat 404 as "no data" rather than an error. Used for pre-feature
 * sessions where no row exists.
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
  if (rollup.sessions_with_canopy === 0 && rollup.total_injections_offered === 0) return true;
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
 * on the error path.
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

/* ---------- Canopy Entries (browse/detail/reembed) ---------- */

/**
 * Single canopy_entries row as returned by the daemon API. Mirrors the
 * `CanopyEntry` interface in `packages/myco/src/db/schema.ts`. Numeric
 * `embedded` (0/1) is preserved on the wire — the UI converts to boolean
 * for display.
 */
export interface CanopyEntryRow {
  project_id: string;
  machine_id: string;
  path: string;
  content_hash: string;
  size_bytes: number;
  token_estimate: number;
  line_count: number;
  language: string | null;
  exports_json: string | null;
  imports_json: string | null;
  top_comment: string | null;
  mechanical_updated_at: number;
  llm_description: string | null;
  llm_updated_at: number | null;
  embedded: number;
}

export interface CanopyEntriesListResponse {
  rows: CanopyEntryRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface CanopyEntriesQuery {
  limit?: number;
  offset?: number;
  language?: string;
  described?: boolean;
  embedded?: boolean;
  path_prefix?: string;
}

function buildEntriesQueryString(args: CanopyEntriesQuery): string {
  const params = new URLSearchParams();
  if (args.limit !== undefined) params.set('limit', String(args.limit));
  if (args.offset !== undefined) params.set('offset', String(args.offset));
  if (args.language !== undefined) params.set('language', args.language);
  if (args.described !== undefined) params.set('described', String(args.described));
  if (args.embedded !== undefined) params.set('embedded', String(args.embedded));
  if (args.path_prefix !== undefined) params.set('path_prefix', args.path_prefix);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Fetches the paginated list of canopy entries with optional filters. */
export function useCanopyEntries(args: CanopyEntriesQuery) {
  return useQuery<CanopyEntriesListResponse>({
    queryKey: [
      'canopy-entries',
      args.limit ?? null,
      args.offset ?? null,
      args.language ?? null,
      args.described ?? null,
      args.embedded ?? null,
      args.path_prefix ?? null,
    ],
    queryFn: ({ signal }) =>
      fetchJson<CanopyEntriesListResponse>(`/canopy/entries${buildEntriesQueryString(args)}`, { signal }),
    staleTime: ENTRIES_STALE_TIME,
  });
}

/**
 * Fetches a single canopy entry by project-relative path. Returns `null` on
 * 404 so callers can render an inline "not found" state without an error
 * boundary.
 */
export function useCanopyEntry(path: string | undefined) {
  return useQuery<CanopyEntryRow | null>({
    queryKey: ['canopy-entry', path],
    queryFn: ({ signal }) =>
      fetchJsonOrNullOn404<CanopyEntryRow>(`/canopy/entries/${encodeURIComponent(path ?? '')}`, signal),
    enabled: typeof path === 'string' && path.length > 0,
    staleTime: ENTRIES_STALE_TIME,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });
}

/**
 * Marks an entry as needing re-embed by POSTing to its `/reembed` endpoint.
 * On success, invalidates list and detail caches so the embedded badge
 * flips back to "No" until the next embedder run.
 */
export function useReembedCanopyEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      return postJson<{ ok: true }>(`/canopy/entries/${encodeURIComponent(path)}/reembed`);
    },
    onSuccess: (_data, path) => {
      void qc.invalidateQueries({ queryKey: ['canopy-entries'] });
      void qc.invalidateQueries({ queryKey: ['canopy-entry', path] });
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
