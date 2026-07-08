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
  /** True when a user has materialized (claimed) the wiki into the repo — drives Open-in-editor and the AGENTS.md pointer expectation. */
  claimedBundleExists: boolean;
  bundleGeneration: number | null;
  inputsHash: string | null;
  generatedAt: string | null;
  lastResult: string | null;
  byType: Record<string, number> | null;
  pageCount: number | null;
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

/* ---------- Document pages ---------- */

/**
 * One published OKF document page's frontmatter fields, as returned by
 * `GET /api/okf/pages` (list) — no `body`. Mirrors `OkfBundle.listPages()`.
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

const OKF_PAGES_BASE_KEY = ['okf-pages'] as const;

/** GET /api/okf/pages — every published page, for the structure tree. */
export function useOkfDocuments(): UseQueryResult<OkfPagesListResponse> {
  const queryKey = useProjectScopedQueryKey(OKF_PAGES_BASE_KEY);
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchJson<OkfPagesListResponse>('/okf/pages', { signal }),
  });
}

/* ---------- Mutations ---------- */

export interface OkfAcknowledgeResponse {
  ok: boolean;
  /** True when a blocked wiki generation was published by this acknowledge. */
  published: boolean;
  generation?: number;
  pageCount?: number;
}

/**
 * POST /api/okf/acknowledge. Publishes the latest blocked wiki generation —
 * the content is already synthesized as durable rows, so acknowledge means
 * ship, not run-again. Invalidates status and pages so the publish-block
 * clears and the structure tree reflects the newly published pages.
 */
export function useOkfAcknowledge() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(OKF_STATUS_BASE_KEY);
  return useMutation({
    mutationFn: () => postJson<OkfAcknowledgeResponse>('/okf/acknowledge', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      void qc.invalidateQueries({ queryKey: OKF_STATUS_BASE_KEY });
      void qc.invalidateQueries({ queryKey: OKF_PAGES_BASE_KEY });
    },
  });
}
