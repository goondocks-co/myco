// SPDX-License-Identifier: Apache-2.0

import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';

export interface ReleaseProvenanceAnnotationDetail {
  state: string;
  confidence: string;
  basis_kind: string | null;
  basis_ref: string | null;
  basis_sha: string | null;
  reason: string | null;
  checked_at: number;
  source_session_id: string | null;
  source_prompt_batch_id: number | null;
  release_pr_number: number | null;
}

export interface ReleaseProvenanceGitRow {
  id: number;
  capture_point: string;
  captured_at: number;
  branch: string | null;
  head_sha: string | null;
  upstream_ref: string | null;
  production_ref: string | null;
  is_dirty: boolean;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  changed_paths: string[];
  patch_ids: unknown[];
  error: string | null;
}

export interface ReleaseProvenanceDetail {
  namespace: string;
  record_id: string;
  annotation: ReleaseProvenanceAnnotationDetail;
  evidence: {
    available: boolean;
    value: unknown;
    parse_warning: string | null;
  };
  git_provenance: ReleaseProvenanceGitRow[];
  readiness: {
    enabled: boolean;
    production_refs: string[];
    integration_refs: string[];
    github: {
      repo_configured: boolean;
      token_available: boolean;
    };
    warnings: string[];
  };
}

export function useReleaseProvenanceDetail(
  namespace: string | undefined,
  recordId: string | undefined,
  enabled: boolean,
) {
  return usePowerQuery<ReleaseProvenanceDetail>({
    queryKey: ['release-provenance', namespace, recordId],
    queryFn: ({ signal }) => fetchJson<ReleaseProvenanceDetail>(
      `/release-provenance/${encodeURIComponent(namespace ?? '')}/${encodeURIComponent(recordId ?? '')}`,
      { signal },
    ),
    enabled: enabled && Boolean(namespace && recordId),
    pollCategory: 'standard',
    refetchInterval: false,
  });
}
