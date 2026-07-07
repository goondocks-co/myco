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

export type OkfIncludeKind = 'spores' | 'canopy' | 'concepts' | 'guides';

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

/**
 * Shape of `GET /api/okf/status` — frozen by Plan 5
 * (packages/myco/src/daemon/api/okf.ts:handleOkfStatus). `lastRun` is null
 * until Plan 6 (okf-maintain task) fills it from agent_runs; render a
 * graceful empty state rather than treating it as an error.
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
  enabled: boolean;
  outputPath: string;
  validation: OkfValidationSummary | null;
  agentsPointer: OkfAgentsPointerState;
  publishEligibility: OkfPublishEligibility;
  lastRun: { status: string; finishedAt: string | null } | null;
}

export interface OkfMaintainBody {
  include?: Partial<Record<OkfIncludeKind, boolean>>;
  sporeStatus?: 'active' | 'superseded' | 'consolidated' | 'obsolete' | 'all';
  includeUndescribedCanopy?: boolean;
  dryRun?: boolean;
  oneShot?: boolean;
  overwrite?: boolean;
  acknowledgePublish?: boolean;
}

export interface OkfMaintainResponse {
  ok: boolean;
  result: unknown;
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

/* ---------- Maintain error surfacing ---------- */

export interface OkfMaintainErrorInfo {
  /** OkfError code, or null when the failure carried none (network error, etc). */
  code: string | null;
  message: string;
  /** Set only for `okf_publish_not_acknowledged` — the findings blocking publish. */
  findings: OkfPublishFinding[] | null;
  /** Set only for `okf_validation_failed` — names the failed page + remediation. */
  validationHint: string | null;
}

interface OkfValidationIssueLike {
  level: string;
  path: string;
  message: string;
}

/**
 * Turns a `useOkfMaintain` mutation error into a renderable shape. Every
 * maintain failure must reach the screen — this is the fix for the
 * naive-first-user bug where a 422 publish-block was thrown by the daemon
 * and nothing ever read `maintain.error`, so "Maintain Now" appeared to do
 * nothing. Duck-types on `{body, message}` rather than `instanceof ApiError`
 * so it works for any error-shaped rejection, not just the fetch-layer class.
 */
export function parseOkfMaintainError(error: unknown): OkfMaintainErrorInfo | null {
  if (!error) return null;
  const err = error as { body?: unknown; message?: string };
  const body = err.body && typeof err.body === 'object' ? (err.body as Record<string, unknown>) : null;
  const errorField = body?.error;
  const code =
    typeof errorField === 'object' && errorField !== null && typeof (errorField as { code?: unknown }).code === 'string'
      ? (errorField as { code: string }).code
      : null;
  const bodyMessage =
    typeof errorField === 'object' && errorField !== null && typeof (errorField as { message?: unknown }).message === 'string'
      ? (errorField as { message: string }).message
      : null;
  const message = bodyMessage ?? (typeof err.message === 'string' && err.message.length > 0 ? err.message : 'Maintain failed.');

  const details = body?.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : null;

  const findings =
    code === 'okf_publish_not_acknowledged' && Array.isArray(details?.findings)
      ? (details!.findings as OkfPublishFinding[])
      : null;

  let validationHint: string | null = null;
  if (code === 'okf_validation_failed') {
    const validation = details?.validation as { issues?: OkfValidationIssueLike[] } | undefined;
    const firstError = validation?.issues?.find((issue) => issue.level === 'error') ?? validation?.issues?.[0];
    validationHint = firstError
      ? `${firstError.path} — ${firstError.message}. Fix or remove the hand-edited page, or trigger a full rebuild.`
      : 'A carried-forward page failed validation. Fix or remove the hand-edited page, or trigger a full rebuild.';
  }

  return { code, message, findings, validationHint };
}

/* ---------- Mutations ---------- */

/**
 * POST /api/okf/maintain. The publish-acknowledgement flow re-invokes this
 * mutation with `acknowledgePublish: true` — there is no separate ack
 * endpoint (MCP has no ack path either). Invalidates the status query on
 * success so the page/panel picks up the new bundle generation immediately.
 */
export function useOkfMaintain() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(OKF_STATUS_BASE_KEY);
  return useMutation({
    mutationFn: (body?: OkfMaintainBody) =>
      postJson<OkfMaintainResponse>('/okf/maintain', body ?? {}),
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
