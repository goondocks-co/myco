import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
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
  counts: Record<OkfIncludeKind, number> | null;
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
