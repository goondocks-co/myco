import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchJson, postJson } from '../lib/api';
import { useActiveProjectSelection, useProjectScopedQueryKey } from './use-project-selection';
import {
  requestContextHeadersForSelection,
  selectionKey,
  type ProjectSelection,
} from '../lib/selection';

/* ---------- Types ---------- */

export interface OkfValidationSummary {
  ok: boolean;
  level: string;
  filesChecked: number;
  conceptsChecked: number;
}

export interface OkfPublishFinding {
  code: string;
  path: string;
  excerpt: string;
}

export interface OkfPublishEligibility {
  /** "NOT blocked" — every current finding is acknowledged. NOT "zero findings". */
  ok: boolean;
  findings: OkfPublishFinding[];
}

export interface OkfAgentsPointerState {
  present: boolean;
  stale: boolean;
}

/** One entry in `status.pendingFindings` — a finding that blocked the most recent synthesis publish. */
export interface OkfPendingFinding {
  code: string;
  path: string;
  hash?: string;
}

/**
 * Shape of `GET /api/okf/status` — frozen by Plan 5
 * (packages/myco/src/daemon/api/okf.ts:handleOkfStatus), extended by Task 7.1
 * with `pendingFindings`. `lastRun` is null until the `okf-synthesize` task
 * fills it from agent_runs; render a graceful empty state rather than
 * treating it as an error.
 */
export interface OkfStatusResponse {
  outputRoot: string;
  bundleExists: boolean;
  bundleGeneration: number | null;
  inputsHash: string | null;
  generatedAt: string | null;
  lastResult: string | null;
  byType: Record<string, number> | null;
  conceptCount: number | null;
  stale: boolean;
  publishAcknowledged: boolean;
  /** Findings that blocked the last synthesis publish, persisted to the manifest — the source `publishEligibility.ok` folds in so a blocked run stays visible on a plain reload. */
  pendingFindings: OkfPendingFinding[];
  enabled: boolean;
  outputPath: string;
  validation: OkfValidationSummary | null;
  agentsPointer: OkfAgentsPointerState;
  publishEligibility: OkfPublishEligibility;
  lastRun: { status: string; finishedAt: string | null } | null;
}

export interface OkfValidateBody {
  path?: string;
}

export interface OkfValidateResponse {
  ok: boolean;
  validation: OkfValidationSummary;
}

/* ---------- Query keys ---------- */

const OKF_STATUS_BASE_KEY = ['okf-status'] as const;

/* ---------- Status queries ---------- */

/**
 * Status query bound to an EXPLICIT selection rather than the route-bound
 * ProjectSelectionContext. `fetchJson`'s default header-building
 * (`buildHeaders` in lib/api.ts) reads the module-level "current request
 * selection", which is only set by `ProjectSelectionBoundary` — machine-scoped
 * routes like /symbionts render under `GlobalSelectionBoundary` and leave it
 * null. Passing `requestContextHeadersForSelection(selection)` explicitly
 * (mirroring use-scoped-config.ts:42-62) means the Symbionts readiness panel
 * gets real project-context headers even though the route itself carries none.
 */
export function useOkfStatusForSelection(
  selection: ProjectSelection | null,
): UseQueryResult<OkfStatusResponse> {
  const activeSelectionKey = selectionKey(selection);
  const contextHeaders = requestContextHeadersForSelection(selection);
  return useQuery({
    queryKey: [...OKF_STATUS_BASE_KEY, activeSelectionKey],
    queryFn: ({ signal }) =>
      fetchJson<OkfStatusResponse>('/okf/status', { signal, headers: contextHeaders }),
    enabled: !!selection,
  });
}

/** Route-bound wrapper for the OKF page — resolves the active selection and
 *  keys the query the same way every other project-scoped hook does. */
export function useOkfStatus(): UseQueryResult<OkfStatusResponse> {
  const selection = useActiveProjectSelection();
  return useOkfStatusForSelection(selection);
}

/**
 * Returns a callback that invalidates every project's OKF status query.
 * The enable toggle writes `okf.enabled` through the scoped-config hook, which
 * does NOT know about this query — call this on the capability transition so
 * the page reflects the new enabled state (and refreshed bundle metadata)
 * without a manual reload. Prefix-matches all `selectionKey`-suffixed keys.
 */
export function useInvalidateOkfStatus(): () => void {
  const qc = useQueryClient();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: OKF_STATUS_BASE_KEY });
  }, [qc]);
}

/* ---------- Document pages (knowledge browser, Task 5.1) ---------- */

/**
 * One published OKF document page's frontmatter fields, as returned by
 * `GET /api/okf/pages` (list) — no `body`. Mirrors
 * `OkfBundle.listPages()` (packages/myco/src/okf/bundle.ts:1578).
 */
export interface OkfPageSummary {
  path: string;
  type: string;
  title?: string;
  description?: string;
  timestamp?: string;
}

export interface OkfPagesListResponse {
  ok: boolean;
  pages: OkfPageSummary[];
}

/**
 * One page's frontmatter fields plus its markdown body, as returned by
 * `GET /api/okf/pages/*` (get). Mirrors `OkfBundle.getPage()`
 * (packages/myco/src/okf/bundle.ts:1648). `body` is markdown source — the
 * detail view renders it client-side, it is not pre-rendered HTML.
 */
export interface OkfPageDetail extends OkfPageSummary {
  body: string;
}

/**
 * `page` is `null` (not a 404) when the bundle-relative path doesn't
 * resolve to a readable page — same "missing/unsafe/unparseable is
 * reported as not found" posture `getPage` uses everywhere else.
 */
export interface OkfPageGetResponse {
  ok: boolean;
  page: OkfPageDetail | null;
}

const OKF_PAGES_BASE_KEY = ['okf-pages'] as const;

/** GET /api/okf/pages — every published page, for the knowledge browser's grouped list. */
export function useOkfDocuments(): UseQueryResult<OkfPagesListResponse> {
  const queryKey = useProjectScopedQueryKey(OKF_PAGES_BASE_KEY);
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchJson<OkfPagesListResponse>('/okf/pages', { signal }),
  });
}

/**
 * GET /api/okf/pages/* — one page's parsed frontmatter + markdown body, by
 * bundle-relative path. `encodeURIComponent` on the whole path (slashes
 * included) mirrors `useCanopyEntry`'s wildcard-route convention
 * (use-canopy.ts) — the daemon's prefix router captures the raw pathname
 * tail and `decodeURIComponent`s it once, so an encoded `/` round-trips.
 */
export function useOkfDocument(path: string | undefined): UseQueryResult<OkfPageGetResponse> {
  const queryKey = useProjectScopedQueryKey(['okf-page', path]);
  return useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<OkfPageGetResponse>(`/okf/pages/${encodeURIComponent(path ?? '')}`, { signal }),
    enabled: typeof path === 'string' && path.length > 0,
  });
}

/* ---------- Mutations ---------- */

export interface OkfAcknowledgeResponse {
  ok: boolean;
  /**
   * The raw `OkfBundleStatus` from `bundle.acknowledgePendingFindings()` —
   * NOT the enriched `OkfStatusResponse` shape (`handleOkfStatus` layers
   * enabled/outputPath/validation/agentsPointer/publishEligibility/lastRun on
   * top of it). Unused here — the status-query invalidation below refetches
   * the enriched shape instead of trusting this narrower one.
   */
  status: unknown;
}

/**
 * POST /api/okf/acknowledge. Drains `manifest.pending_findings` into
 * `acknowledged_findings` so the next `okf-synthesize` run publishes — the
 * synthesis-world replacement for the dead `maintain({acknowledgePublish:
 * true})` path. Invalidates the status query on success so the publish-block
 * clears once the refreshed status reports `publishEligibility.ok`.
 */
export function useOkfAcknowledge() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(OKF_STATUS_BASE_KEY);
  return useMutation({
    mutationFn: () => postJson<OkfAcknowledgeResponse>('/okf/acknowledge', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: OKF_STATUS_BASE_KEY });
    },
  });
}

/** POST /api/okf/validate. Invalidates status so the validation summary refreshes. */
export function useOkfValidate() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(OKF_STATUS_BASE_KEY);
  return useMutation({
    mutationFn: (body?: OkfValidateBody) =>
      postJson<OkfValidateResponse>('/okf/validate', body ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: OKF_STATUS_BASE_KEY });
    },
  });
}
