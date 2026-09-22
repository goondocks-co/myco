import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson, putJson } from '../lib/api';

export interface PackageTagMapping { pathGlob: string; tagPattern: string }

export interface ReleaseCheck {
  requestedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  status: 'complete' | 'partial' | 'unavailable' | null;
  failure: string | null;
  counts: { checked: number; changed: number; unchanged: number; unknown: number; unavailable: number; deferred: number } | null;
  lookups: number | null;
  lastCompleteAt: number | null;
}

export interface ReleaseProvenanceRow {
  enabled: boolean;
  githubRepo: string | null;
  productionRefs: string[];
  integrationRefs: string[];
  packageMap: PackageTagMapping[];
  includeUnknown: boolean;
  maxLookups: number;
  revision: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
  credential: { configured: boolean; purpose: string };
  suggestedRepo: string | null;
  check: ReleaseCheck | null;
  problem: 'stored_settings_unreadable' | null;
}

export type ReleaseProvenanceWrite = Pick<ReleaseProvenanceRow, 'enabled' | 'githubRepo' | 'productionRefs' | 'integrationRefs' | 'packageMap' | 'includeUnknown' | 'maxLookups' | 'revision'>
  & { credential?: { token: string } | null };

/** A record's release state as the server presents it on every surface. */
export interface ReleaseStatus {
  state: string;
  confidence: string;
  ref: string | null;
  reason: string | null;
  checkedAt: number;
  latestCheck: { status: string; failure: string | null; finishedAt: number } | null;
}

const key = (projectId: string) => ['release-provenance', projectId];
const path = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/release-provenance`;

/** How often the settings are read again while a requested or running check has not finished. */
export const RELEASE_CHECK_REFRESH_MS = 2_000;

/** A check was requested after the latest one started, or the latest one has not finished. */
export function checkPending(check: ReleaseCheck | null | undefined): boolean {
  if (!check) return false;
  if (check.requestedAt !== null && (check.startedAt === null || check.requestedAt > check.startedAt)) return true;
  return check.startedAt !== null && (check.finishedAt === null || check.finishedAt < check.startedAt);
}

export function useReleaseProvenance(projectId: string) {
  return useQuery({
    queryKey: key(projectId),
    queryFn: ({ signal }) => fetchJson<{ releaseProvenance: ReleaseProvenanceRow }>(path(projectId), signal),
    refetchInterval: (query) => (checkPending(query.state.data?.releaseProvenance.check) ? RELEASE_CHECK_REFRESH_MS : false),
  });
}

export function useReleaseProvenanceActions(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: key(projectId) });
  return {
    save: useMutation({
      gcTime: 0,
      mutationFn: (input: ReleaseProvenanceWrite) => putJson<{ releaseProvenance: ReleaseProvenanceRow }>(path(projectId), input),
      onSuccess: refresh,
    }),
    check: useMutation({
      mutationFn: () => postJson<{ requested: boolean }>(`${path(projectId)}/check`, {}),
      onSuccess: refresh,
    }),
  };
}
