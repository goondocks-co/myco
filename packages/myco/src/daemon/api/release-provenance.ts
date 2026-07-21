// SPDX-License-Identifier: Apache-2.0

import type { MycoConfig } from '@myco/config/schema.js';
import {
  listGitProvenance,
  getReleaseState,
  RELEASE_NAMESPACES,
  type GitProvenanceRow,
  type ReleaseNamespace,
  type ReleaseStateRow,
} from '@myco/db/queries/release-provenance.js';
import { assertGroveProjectId, projectScope } from '@myco/grove/ids.js';
import { releaseProvenanceConfig } from '@myco/release-provenance/config.js';
import type { RequestPrincipal } from '../request-principal.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';
import { resolveTenantConfig } from '../request-config.js';
import { errorBody } from './error-envelope.js';

const DETAIL_GIT_ROW_LIMIT = 20;
const NAMESPACE_SET = new Set<string>(RELEASE_NAMESPACES);

export interface ReleaseProvenanceDetailResponse {
  namespace: ReleaseNamespace;
  record_id: string;
  annotation: {
    state: string;
    confidence: string;
    basis_kind: string | null;
    basis_ref: string | null;
    basis_sha: string | null;
    reason: string | null;
    checked_at: number;
    source_session_id: string | null;
    source_prompt_batch_id: string | null;
    release_pr_number: number | null;
  };
  evidence: {
    available: boolean;
    value: unknown;
    parse_warning: string | null;
  };
  git_provenance: ReleaseProvenanceGitRow[];
  readiness: ReleaseProvenanceReadiness;
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

export interface ReleaseProvenanceReadiness {
  enabled: boolean;
  production_refs: string[];
  integration_refs: string[];
  github: {
    repo_configured: boolean;
    token_available: boolean;
  };
  warnings: string[];
}

export function createReleaseProvenanceHandlers(deps: {
  liveConfig: { current: MycoConfig };
  logger?: DaemonLogger;
}) {
  return {
    handleGetReleaseProvenanceDetail: async (
      req: RouteRequest,
      principal: RequestPrincipal,
    ): Promise<RouteResponse> => {
      const namespaceParam = req.params.namespace;
      const recordId = req.params.recordId;

      if (!namespaceParam || !NAMESPACE_SET.has(namespaceParam)) {
        return {
          status: 400,
          body: errorBody(
            'invalid_release_namespace',
            `Unknown release provenance namespace: ${namespaceParam ?? ''}`,
          ),
        };
      }
      if (!recordId) {
        return {
          status: 404,
          body: errorBody(
            'release_provenance_not_found',
            `No release provenance row found for ${namespaceParam}/`,
          ),
        };
      }

      const namespace = namespaceParam as ReleaseNamespace;
      const scope = projectScope(assertGroveProjectId(principal.tenancy.projectId));
      const annotation = getReleaseState(namespace, recordId, scope);
      if (!annotation) {
        return {
          status: 404,
          body: errorBody(
            'release_provenance_not_found',
            `No release provenance row found for ${namespace}/${recordId}`,
          ),
        };
      }

      return {
        body: {
          namespace,
          record_id: recordId,
          annotation: shapeAnnotation(annotation),
          evidence: parseEvidence(annotation.evidence_json),
          git_provenance: listBoundedGitEvidence(annotation, scope),
          readiness: buildReadiness(
            resolveTenantConfig(req.requestContext, deps.liveConfig.current, { logger: deps.logger }),
          ),
        } satisfies ReleaseProvenanceDetailResponse,
      };
    },
  };
}

function shapeAnnotation(row: ReleaseStateRow): ReleaseProvenanceDetailResponse['annotation'] {
  return {
    state: row.state,
    confidence: row.confidence,
    basis_kind: row.basis_kind,
    basis_ref: row.basis_ref,
    basis_sha: row.basis_sha,
    reason: row.reason,
    checked_at: row.checked_at,
    source_session_id: row.source_session_id,
    source_prompt_batch_id: row.source_prompt_batch_id,
    release_pr_number: row.release_pr_number,
  };
}

function parseEvidence(evidenceJson: string | null): ReleaseProvenanceDetailResponse['evidence'] {
  if (!evidenceJson) {
    return { available: false, value: null, parse_warning: null };
  }
  try {
    return { available: true, value: JSON.parse(evidenceJson) as unknown, parse_warning: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      available: true,
      value: null,
      parse_warning: `Failed to parse evidence_json: ${message}`,
    };
  }
}

function listBoundedGitEvidence(
  row: ReleaseStateRow,
  scope: Parameters<typeof listGitProvenance>[0]['scope'],
): ReleaseProvenanceGitRow[] {
  const byId = new Map<number, GitProvenanceRow>();
  if (row.source_session_id) {
    for (const gitRow of listGitProvenance({
      scope,
      session_id: row.source_session_id,
      limit: DETAIL_GIT_ROW_LIMIT,
    })) {
      byId.set(gitRow.id, gitRow);
    }
  }
  if (row.source_prompt_batch_id !== null) {
    for (const gitRow of listGitProvenance({
      scope,
      prompt_batch_id: row.source_prompt_batch_id,
      limit: DETAIL_GIT_ROW_LIMIT,
    })) {
      byId.set(gitRow.id, gitRow);
    }
  }
  if (row.basis_sha) {
    for (const gitRow of listGitProvenance({
      scope,
      head_sha: row.basis_sha,
      limit: DETAIL_GIT_ROW_LIMIT,
    })) {
      byId.set(gitRow.id, gitRow);
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.captured_at - a.captured_at || b.id - a.id)
    .slice(0, DETAIL_GIT_ROW_LIMIT)
    .map(shapeGitRow);
}

function shapeGitRow(row: GitProvenanceRow): ReleaseProvenanceGitRow {
  return {
    id: row.id,
    capture_point: row.capture_point,
    captured_at: row.captured_at,
    branch: row.branch,
    head_sha: row.head_sha,
    upstream_ref: row.upstream_ref,
    production_ref: row.production_ref,
    is_dirty: row.is_dirty === 1,
    staged_count: row.staged_count,
    unstaged_count: row.unstaged_count,
    untracked_count: row.untracked_count,
    changed_paths: parseStringArray(row.changed_paths_json),
    patch_ids: parseArray(row.patch_ids_json),
    error: row.error,
  };
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildReadiness(config: MycoConfig): ReleaseProvenanceReadiness {
  const release = releaseProvenanceConfig(config);
  const repoConfigured = release.github.repo.trim().length > 0;
  const tokenAvailable = repoConfigured && Boolean(process.env[release.github.token_env]);
  const warnings: string[] = [];

  if (!release.enabled) warnings.push('disabled');
  if (release.production_refs.length === 0) warnings.push('missing_production_refs');
  if (release.integration_refs.length === 0) warnings.push('missing_integration_refs');
  if (repoConfigured && !tokenAvailable) warnings.push('repo_configured_but_token_missing');

  return {
    enabled: release.enabled,
    production_refs: release.production_refs,
    integration_refs: release.integration_refs,
    github: {
      repo_configured: repoConfigured,
      token_available: tokenAvailable,
    },
    warnings,
  };
}
