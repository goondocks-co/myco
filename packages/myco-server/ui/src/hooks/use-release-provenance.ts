import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson, putJson } from '../lib/api';

import type { ReleaseCheck, ReleaseProvenanceAnswer, ReleaseProvenanceRow } from '../features/admin/project/wire';
export type { PackageTagMapping, ReleaseCheck, ReleaseProvenanceRow } from '../features/admin/project/wire';

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
    queryFn: ({ signal }) => fetchJson<ReleaseProvenanceAnswer>(path(projectId), signal),
    refetchInterval: (query) => (checkPending(query.state.data?.releaseProvenance.check) ? RELEASE_CHECK_REFRESH_MS : false),
  });
}

export function useReleaseProvenanceActions(projectId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: key(projectId) });
  return {
    save: useMutation({
      gcTime: 0,
      mutationFn: (input: ReleaseProvenanceWrite) => putJson<ReleaseProvenanceAnswer>(path(projectId), input),
      onSuccess: refresh,
    }),
    check: useMutation({
      mutationFn: () => postJson<{ requested: boolean }>(`${path(projectId)}/check`, {}),
      onSuccess: refresh,
    }),
  };
}
