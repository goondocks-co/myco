import type { DaemonLogger } from '@myco/daemon/logger.js';
import {
  buildReleaseStateIdentityKey,
  getReleaseStateByIdentityKey,
  listGitProvenance,
  touchReleaseStateCheckedAt,
  upsertReleaseState,
  type GitProvenanceRow,
  type ReleaseBasisKind,
  type ReleaseConfidence,
  type ReleaseNamespace,
  type ReleaseStateValue,
} from '@myco/db/queries/release-provenance.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import { epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { ReleaseProvenanceRuntimeConfig } from './config.js';
import { mergeBase, patchIdForCommit, patchIdForRange, runGit } from './git-cmd.js';
import type { PatchKind } from './git-snapshot.js';
import { findDerivedRecords } from './record-lineage.js';
import { filterRefsByPackagePatterns, tagPatternsForChangedPaths } from './package-map.js';
import { findSquashMergeForCommit, readGithubToken } from './github.js';

export interface ReleaseStateChange {
  namespace: ReleaseNamespace;
  recordId: string;
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basisKind: ReleaseBasisKind;
  checkedAt: number;
}

const PATCH_SCAN_MAX_COMMITS = 500;
const MAX_EVIDENCE_REF_CHECKS = 8;

interface PullRequestSquashEvidence {
  number: number;
  merge_commit_sha: string;
}

interface CapturedPatchId {
  kind?: string;
  patch_id?: string;
  base_ref?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
}

interface ReleaseTarget {
  namespace: ReleaseNamespace;
  recordId: string;
}

interface RefCheck {
  ref: string;
  ok: boolean;
  error?: string;
}

interface PatchMatch {
  ref: string;
  commit_sha: string;
  patch_id: string;
  patch_kind: string | null;
}

interface Classification {
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basis_kind: ReleaseBasisKind;
  basis_ref: string | null;
  basis_sha: string | null;
  reason: string;
  evidence: Record<string, unknown>;
}

export interface ReconcileReleaseProvenanceInput {
  projectRoot: string;
  projectId?: string | null;
  machineId?: string;
  scope: ProjectScope;
  config: ReleaseProvenanceRuntimeConfig;
  limit?: number;
  now?: number;
  logger?: Pick<DaemonLogger, 'debug' | 'warn' | 'info'>;
  /**
   * Callback fired once per source row whose classification changed. Receives
   * the source change AND any derived records (spores/plans inheriting via
   * session/batch lineage). Used to propagate metadata into the vector store
   * so semantic-search filters stay current.
   */
  onReleaseStateChanged?: (changes: ReleaseStateChange[]) => void;
}

export interface ReconcileReleaseProvenanceResult {
  scanned: number;
  reconciled: number;
  skipped: number;
  unchanged: number;
  failed: number;
  disabled: boolean;
}

/**
 * Cache commit_sha -> patch_id across rows within a single reconcile pass.
 * Many provenance rows reference the same release/integration refs, so commits
 * are revisited dozens or hundreds of times per pass. `null` marks a confirmed
 * miss so we don't shell out for a `git show` that already failed.
 */
class PatchIdCache {
  private readonly commitToPatchId = new Map<string, string | null>();

  patchIdForCommit(projectRoot: string, commitSha: string): string | null {
    const cached = this.commitToPatchId.get(commitSha);
    if (cached !== undefined) return cached;
    const value = patchIdForCommit(projectRoot, commitSha);
    this.commitToPatchId.set(commitSha, value);
    return value;
  }
}

function targetFor(row: GitProvenanceRow): ReleaseTarget | null {
  switch (row.capture_point) {
    case 'session_start':
    case 'session_end':
      return row.session_id ? { namespace: 'sessions', recordId: row.session_id } : null;
    case 'prompt_batch_start':
    case 'prompt_batch_stop':
      return row.prompt_batch_id !== null
        ? { namespace: 'prompt_batches', recordId: String(row.prompt_batch_id) }
        : null;
    default:
      return null;
  }
}

function checkRefs(projectRoot: string, headSha: string, refs: readonly string[]): RefCheck[] {
  return refs.map((ref) => {
    const result = runGit(projectRoot, ['merge-base', '--is-ancestor', headSha, ref]);
    return {
      ref,
      ok: result.ok,
      ...(result.ok || result.status === 1 ? {} : { error: result.error }),
    };
  });
}

function boundedChecks(checks: RefCheck[]): RefCheck[] {
  return checks.length <= MAX_EVIDENCE_REF_CHECKS ? checks : checks.slice(0, MAX_EVIDENCE_REF_CHECKS);
}

function parseCapturedPatchIds(row: GitProvenanceRow): CapturedPatchId[] {
  if (!row.patch_ids_json) return [];
  try {
    const parsed = JSON.parse(row.patch_ids_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is CapturedPatchId => (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as CapturedPatchId).patch_id === 'string'
    ));
  } catch {
    return [];
  }
}

function capturedPatchCandidates(
  row: GitProvenanceRow,
  projectRoot: string,
  refs: readonly string[],
): CapturedPatchId[] {
  const byKey = new Map<string, CapturedPatchId>();
  for (const patch of parseCapturedPatchIds(row)) {
    if (!patch.patch_id) continue;
    byKey.set(`${patch.kind ?? 'unknown'}:${patch.patch_id}`, patch);
  }

  if (row.head_sha) {
    for (const ref of refs) {
      const baseSha = mergeBase(projectRoot, row.head_sha, ref);
      if (!baseSha) continue;
      const patchId = patchIdForRange(projectRoot, baseSha, row.head_sha);
      if (!patchId) continue;
      const kind: PatchKind = 'dynamic_range';
      byKey.set(`${kind}:${patchId}`, {
        kind,
        patch_id: patchId,
        base_ref: ref,
        base_sha: baseSha,
        head_sha: row.head_sha,
      });
    }
  }

  return [...byKey.values()];
}

function findPatchMatch(
  projectRoot: string,
  row: GitProvenanceRow,
  refs: readonly string[],
  cache: PatchIdCache,
): { matches: PatchMatch[]; errors: RefCheck[] } {
  const patches = capturedPatchCandidates(row, projectRoot, refs);
  const wanted = new Map<string, CapturedPatchId>();
  for (const patch of patches) {
    if (patch.patch_id) wanted.set(patch.patch_id, patch);
  }
  if (wanted.size === 0) return { matches: [], errors: [] };

  const matches: PatchMatch[] = [];
  const errors: RefCheck[] = [];

  for (const ref of refs) {
    const revList = runGit(projectRoot, ['rev-list', `--max-count=${PATCH_SCAN_MAX_COMMITS}`, ref]);
    if (!revList.ok) {
      errors.push({ ref, ok: false, error: revList.error });
      continue;
    }
    for (const commitSha of revList.stdout.split('\n')) {
      if (!commitSha) continue;
      const patchId = cache.patchIdForCommit(projectRoot, commitSha);
      if (!patchId) continue;
      const captured = wanted.get(patchId);
      if (!captured) continue;
      matches.push({
        ref,
        commit_sha: commitSha,
        patch_id: patchId,
        patch_kind: captured.kind ?? null,
      });
      break;
    }
    if (matches.length > 0) break;
  }

  return { matches, errors };
}

function buildClassification(
  state: ReleaseStateValue,
  confidence: ReleaseConfidence,
  basis_kind: ReleaseBasisKind,
  basis_ref: string | null,
  basis_sha: string | null,
  reason: string,
  evidence: Record<string, unknown>,
): Classification {
  return { state, confidence, basis_kind, basis_ref, basis_sha, reason, evidence };
}

function parseChangedPaths(row: GitProvenanceRow): string[] {
  if (!row.changed_paths_json) return [];
  try {
    const parsed = JSON.parse(row.changed_paths_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

function selectRefsForRow(
  row: GitProvenanceRow,
  config: ReleaseProvenanceRuntimeConfig,
): { production: string[]; integration: string[] } {
  const changed = parseChangedPaths(row);
  const packageMap = config.package_map ?? [];
  if (packageMap.length === 0 || changed.length === 0) {
    return { production: [...config.production_refs], integration: [...config.integration_refs] };
  }
  const patterns = tagPatternsForChangedPaths(changed, packageMap);
  return {
    production: filterRefsByPackagePatterns(config.production_refs, patterns),
    integration: filterRefsByPackagePatterns(config.integration_refs, patterns),
  };
}

function classify(
  row: GitProvenanceRow,
  input: ReconcileReleaseProvenanceInput,
  cache: PatchIdCache,
  prSquash: PullRequestSquashEvidence | null,
): Classification {
  const baseEvidence = {
    provenance_id: row.id,
    capture_point: row.capture_point,
    head_sha: row.head_sha,
    dirty_counts: {
      staged: row.staged_count,
      unstaged: row.unstaged_count,
      untracked: row.untracked_count,
    },
  };

  if (row.error || !row.head_sha) {
    return buildClassification(
      'unknown', 'low', 'missing_git_evidence', null, row.head_sha,
      row.error ?? 'No captured Git HEAD SHA',
      baseEvidence,
    );
  }

  const { production: productionRefs, integration: integrationRefs } = selectRefsForRow(row, input.config);
  if (productionRefs.length === 0 && integrationRefs.length === 0) {
    return buildClassification(
      'unreconciled', 'low', 'configuration', null, row.head_sha,
      'No release provenance refs configured',
      baseEvidence,
    );
  }

  if (row.is_dirty) {
    return buildClassification(
      'unknown', 'low', 'dirty_worktree', null, row.head_sha,
      'Captured working tree had uncommitted changes',
      baseEvidence,
    );
  }

  // Direct ancestry against production refs (highest confidence).
  const productionChecks = checkRefs(input.projectRoot, row.head_sha, productionRefs);
  const released = productionChecks.find((check) => check.ok);
  if (released) {
    return buildClassification(
      'released', 'high', 'git_ancestry', released.ref, row.head_sha,
      `Captured HEAD is contained in production ref ${released.ref}`,
      { ...baseEvidence, checked_refs: boundedChecks(productionChecks) },
    );
  }

  // Patch-id equivalence against production refs (squash-merge case).
  const productionPatchMatch = findPatchMatch(input.projectRoot, row, productionRefs, cache);
  const releasedByPatch = productionPatchMatch.matches[0];
  if (releasedByPatch) {
    return buildClassification(
      'released', 'medium', 'git_patch_id', releasedByPatch.ref, releasedByPatch.commit_sha,
      `Captured patch is equivalent to a commit in production ref ${releasedByPatch.ref}`,
      {
        ...baseEvidence,
        checked_refs: boundedChecks(productionChecks),
        patch_match: releasedByPatch,
        patch_scan: {
          max_commits_per_ref: PATCH_SCAN_MAX_COMMITS,
          errors: productionPatchMatch.errors,
        },
      },
    );
  }

  // PR squash-merge evidence: when the captured HEAD was a feature-branch
  // tip and the PR was squash-merged onto a base branch, the squash commit
  // has a different SHA. Re-check ancestry against the squash commit before
  // falling through to integration refs.
  if (prSquash) {
    const squashAncestry = checkRefs(input.projectRoot, prSquash.merge_commit_sha, productionRefs);
    const releasedBySquash = squashAncestry.find((check) => check.ok);
    if (releasedBySquash) {
      return buildClassification(
        'released', 'high', 'github_pr_squash', releasedBySquash.ref, prSquash.merge_commit_sha,
        `PR #${prSquash.number} squash-merge commit is contained in production ref ${releasedBySquash.ref}`,
        {
          ...baseEvidence,
          checked_refs: boundedChecks(productionChecks),
          pull_request: { number: prSquash.number, merge_commit_sha: prSquash.merge_commit_sha },
          checked_refs_after_squash: boundedChecks(squashAncestry),
        },
      );
    }
  }

  // Same checks against integration refs (merged but not released).
  const integrationChecks = checkRefs(input.projectRoot, row.head_sha, integrationRefs);
  const merged = integrationChecks.find((check) => check.ok);
  if (merged) {
    return buildClassification(
      'merged_unreleased', 'medium', 'git_ancestry', merged.ref, row.head_sha,
      `Captured HEAD is contained in integration ref ${merged.ref} but not a production ref`,
      { ...baseEvidence, checked_refs: boundedChecks([...productionChecks, ...integrationChecks]) },
    );
  }

  const integrationPatchMatch = findPatchMatch(input.projectRoot, row, integrationRefs, cache);
  const mergedByPatch = integrationPatchMatch.matches[0];
  if (mergedByPatch) {
    return buildClassification(
      'merged_unreleased', 'medium', 'git_patch_id', mergedByPatch.ref, mergedByPatch.commit_sha,
      `Captured patch is equivalent to a commit in integration ref ${mergedByPatch.ref} but not a production ref`,
      {
        ...baseEvidence,
        checked_refs: boundedChecks([...productionChecks, ...integrationChecks]),
        patch_match: mergedByPatch,
        patch_scan: {
          max_commits_per_ref: PATCH_SCAN_MAX_COMMITS,
          errors: [...productionPatchMatch.errors, ...integrationPatchMatch.errors],
        },
      },
    );
  }

  const allChecks = [...productionChecks, ...integrationChecks];
  if (allChecks.length > 0 && allChecks.every((check) => check.error)) {
    return buildClassification(
      'unknown', 'low', 'ref_check_failed', null, row.head_sha,
      'Configured release refs could not be checked',
      { ...baseEvidence, checked_refs: boundedChecks(allChecks) },
    );
  }

  return buildClassification(
    'not_on_release_line', 'medium', 'git_ancestry', null, row.head_sha,
    'Captured HEAD is not contained in configured release refs',
    { ...baseEvidence, checked_refs: boundedChecks(allChecks) },
  );
}

function classificationUnchanged(
  existing: ReturnType<typeof getReleaseStateByIdentityKey>,
  next: Classification,
): boolean {
  if (!existing) return false;
  return existing.state === next.state
    && existing.confidence === next.confidence
    && existing.basis_kind === next.basis_kind
    && existing.basis_ref === next.basis_ref
    && existing.basis_sha === next.basis_sha
    && existing.reason === next.reason;
}

async function resolvePullRequestSquash(
  row: GitProvenanceRow,
  input: ReconcileReleaseProvenanceInput,
  remainingBudget: { value: number },
): Promise<PullRequestSquashEvidence | null> {
  if (remainingBudget.value <= 0 || !row.head_sha) return null;
  const github = input.config.github;
  if (!github || !github.repo) return null;
  const token = readGithubToken(github);
  if (!token) return null;
  remainingBudget.value--;
  const pr = await findSquashMergeForCommit(row.head_sha, { repo: github.repo, token });
  return pr ? { number: pr.number, merge_commit_sha: pr.merge_commit_sha } : null;
}

export async function reconcileReleaseProvenance(
  input: ReconcileReleaseProvenanceInput,
): Promise<ReconcileReleaseProvenanceResult> {
  if (!input.config.enabled) {
    return { scanned: 0, reconciled: 0, skipped: 0, unchanged: 0, failed: 0, disabled: true };
  }

  const now = input.now ?? epochSeconds();
  const rows = listGitProvenance({ scope: input.scope, limit: input.limit ?? 500 });
  const seen = new Set<string>();
  const cache = new PatchIdCache();
  const githubBudget = { value: input.config.github?.max_lookups_per_run ?? 0 };
  let reconciled = 0;
  let skipped = 0;
  let unchanged = 0;
  let failed = 0;

  for (const row of rows) {
    const target = targetFor(row);
    if (!target) {
      skipped++;
      continue;
    }
    const key = `${target.namespace}:${target.recordId}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    try {
      const prSquash = await resolvePullRequestSquash(row, input, githubBudget);
      const result = classify(row, input, cache, prSquash);
      const projectId = input.projectId ?? row.project_id;
      const identityKey = buildReleaseStateIdentityKey({
        project_id: projectId,
        namespace: target.namespace,
        record_id: target.recordId,
      });
      const existing = getReleaseStateByIdentityKey(identityKey);
      if (classificationUnchanged(existing, result)) {
        touchReleaseStateCheckedAt(identityKey, now);
        unchanged++;
        continue;
      }

      upsertReleaseState({
        project_id: projectId,
        machine_id: input.machineId ?? row.machine_id,
        namespace: target.namespace,
        record_id: target.recordId,
        source_session_id: row.session_id,
        source_prompt_batch_id: row.prompt_batch_id,
        state: result.state,
        confidence: result.confidence,
        basis_kind: result.basis_kind,
        basis_ref: result.basis_ref,
        basis_sha: result.basis_sha,
        reason: result.reason,
        evidence_json: JSON.stringify(result.evidence),
        checked_at: now,
        created_at: now,
        updated_at: now,
      });

      // Materialize the same classification onto derived embeddable records
      // (spores/plans inheriting via session/batch lineage). Annotation
      // lookups and vector-metadata patches both key by (namespace, record_id),
      // so the only way for derived records to surface release_state today is
      // a materialized row.
      const changes: ReleaseStateChange[] = [{
        namespace: target.namespace,
        recordId: target.recordId,
        state: result.state,
        confidence: result.confidence,
        basisKind: result.basis_kind,
        checkedAt: now,
      }];
      const derived = findDerivedRecords({
        sourceNamespace: target.namespace,
        sourceRecordId: target.recordId,
        scope: input.scope,
      });
      for (const record of derived) {
        upsertReleaseState({
          project_id: projectId,
          machine_id: input.machineId ?? row.machine_id,
          namespace: record.namespace,
          record_id: record.recordId,
          source_session_id: row.session_id,
          source_prompt_batch_id: row.prompt_batch_id,
          state: result.state,
          confidence: result.confidence,
          basis_kind: result.basis_kind,
          basis_ref: result.basis_ref,
          basis_sha: result.basis_sha,
          reason: result.reason,
          evidence_json: JSON.stringify(result.evidence),
          checked_at: now,
          created_at: now,
          updated_at: now,
        });
        changes.push({
          namespace: record.namespace,
          recordId: record.recordId,
          state: result.state,
          confidence: result.confidence,
          basisKind: result.basis_kind,
          checkedAt: now,
        });
      }
      input.onReleaseStateChanged?.(changes);
      reconciled++;
    } catch (err) {
      failed++;
      input.logger?.warn(LOG_KINDS.RELEASE_PROVENANCE_RECONCILE, 'Release provenance row failed', {
        provenance_id: row.id,
        target: key,
        error: (err as Error).message,
      });
    }
  }

  input.logger?.debug(LOG_KINDS.RELEASE_PROVENANCE_RECONCILE, 'Release provenance reconciled', {
    scanned: rows.length,
    reconciled,
    unchanged,
    skipped,
    failed,
    project_id: input.projectId ?? null,
  });

  return { scanned: rows.length, reconciled, skipped, unchanged, failed, disabled: false };
}
