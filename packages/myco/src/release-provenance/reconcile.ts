import { execFileSync } from 'node:child_process';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import {
  listGitProvenance,
  upsertReleaseState,
  type GitProvenanceRow,
  type ReleaseConfidence,
  type ReleaseNamespace,
  type ReleaseStateValue,
} from '@myco/db/queries/release-provenance.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import { epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { ReleaseProvenanceRuntimeConfig } from './config.js';

const GIT_TIMEOUT_MS = 5_000;
const PATCH_SCAN_MAX_COMMITS = 500;

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
  basis_kind: string;
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
}

export interface ReconcileReleaseProvenanceResult {
  scanned: number;
  reconciled: number;
  skipped: number;
  disabled: boolean;
}

function runGit(projectRoot: string, args: string[], input?: string): { ok: boolean; stdout: string; error?: string; status?: number } {
  try {
    const stdout = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
    }).trim();
    return { ok: true, stdout };
  } catch (err) {
    const failure = err as Error & { status?: number };
    return { ok: false, stdout: '', error: failure.message, status: failure.status };
  }
}

function targetFor(row: GitProvenanceRow): ReleaseTarget | null {
  if ((row.capture_point === 'session_start' || row.capture_point === 'session_end') && row.session_id) {
    return { namespace: 'sessions', recordId: row.session_id };
  }
  if ((row.capture_point === 'prompt_batch_start' || row.capture_point === 'prompt_batch_stop') && row.prompt_batch_id !== null) {
    return { namespace: 'prompt_batches', recordId: String(row.prompt_batch_id) };
  }
  return null;
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

function patchIdFromDiff(projectRoot: string, diffOutput: string): string | null {
  if (!diffOutput.trim()) return null;
  const patchId = runGit(projectRoot, ['patch-id', '--stable'], `${diffOutput}\n`);
  if (!patchId.ok || !patchId.stdout.trim()) return null;
  return patchId.stdout.trim().split(/\s+/)[0] ?? null;
}

function patchIdForCommit(projectRoot: string, commitSha: string): string | null {
  const diff = runGit(projectRoot, ['show', '--format=', '--patch', '--find-renames', commitSha]);
  return diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
}

function patchIdForRange(projectRoot: string, baseSha: string, headSha: string): string | null {
  const diff = runGit(projectRoot, ['diff', '--find-renames', baseSha, headSha]);
  return diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
}

function mergeBase(projectRoot: string, left: string, right: string): string | null {
  const result = runGit(projectRoot, ['merge-base', left, right]);
  return result.ok && result.stdout ? result.stdout : null;
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
      byKey.set(`dynamic_range:${patchId}`, {
        kind: 'dynamic_range',
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
): { matches: PatchMatch[]; errors: RefCheck[] } {
  const patches = capturedPatchCandidates(row, projectRoot, refs);
  const wanted = new Map<string, CapturedPatchId>();
  for (const patch of patches) {
    if (patch.patch_id) wanted.set(patch.patch_id, patch);
  }
  if (wanted.size === 0) return { matches: [], errors: [] };

  const matches: PatchMatch[] = [];
  const errors: RefCheck[] = [];
  const seenCommits = new Set<string>();

  for (const ref of refs) {
    const revList = runGit(projectRoot, ['rev-list', `--max-count=${PATCH_SCAN_MAX_COMMITS}`, ref]);
    if (!revList.ok) {
      errors.push({ ref, ok: false, error: revList.error });
      continue;
    }
    for (const commitSha of revList.stdout.split('\n')) {
      if (!commitSha || seenCommits.has(commitSha)) continue;
      seenCommits.add(commitSha);
      const patchId = patchIdForCommit(projectRoot, commitSha);
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
  }

  return { matches, errors };
}

function classify(row: GitProvenanceRow, input: ReconcileReleaseProvenanceInput): Classification {
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
    return {
      state: 'unknown',
      confidence: 'low',
      basis_kind: 'missing_git_evidence',
      basis_ref: null,
      basis_sha: row.head_sha,
      reason: row.error ?? 'No captured Git HEAD SHA',
      evidence: baseEvidence,
    };
  }

  const productionRefs = input.config.production_refs;
  const integrationRefs = input.config.integration_refs;
  if (productionRefs.length === 0 && integrationRefs.length === 0) {
    return {
      state: 'unreconciled',
      confidence: 'low',
      basis_kind: 'configuration',
      basis_ref: null,
      basis_sha: row.head_sha,
      reason: 'No release provenance refs configured',
      evidence: baseEvidence,
    };
  }

  if (row.is_dirty) {
    return {
      state: 'unknown',
      confidence: 'low',
      basis_kind: 'dirty_worktree',
      basis_ref: null,
      basis_sha: row.head_sha,
      reason: 'Captured working tree had uncommitted changes',
      evidence: baseEvidence,
    };
  }

  const productionChecks = checkRefs(input.projectRoot, row.head_sha, productionRefs);
  const released = productionChecks.find((check) => check.ok);
  if (released) {
    return {
      state: 'released',
      confidence: 'high',
      basis_kind: 'git_ancestry',
      basis_ref: released.ref,
      basis_sha: row.head_sha,
      reason: `Captured HEAD is contained in production ref ${released.ref}`,
      evidence: { ...baseEvidence, checked_refs: productionChecks },
    };
  }

  const productionPatchMatch = findPatchMatch(input.projectRoot, row, productionRefs);
  const releasedByPatch = productionPatchMatch.matches[0];
  if (releasedByPatch) {
    return {
      state: 'released',
      confidence: 'medium',
      basis_kind: 'git_patch_id',
      basis_ref: releasedByPatch.ref,
      basis_sha: releasedByPatch.commit_sha,
      reason: `Captured patch is equivalent to a commit in production ref ${releasedByPatch.ref}`,
      evidence: {
        ...baseEvidence,
        checked_refs: productionChecks,
        patch_match: releasedByPatch,
        patch_scan: {
          max_commits_per_ref: PATCH_SCAN_MAX_COMMITS,
          errors: productionPatchMatch.errors,
        },
      },
    };
  }

  const integrationChecks = checkRefs(input.projectRoot, row.head_sha, integrationRefs);
  const merged = integrationChecks.find((check) => check.ok);
  if (merged) {
    return {
      state: 'merged_unreleased',
      confidence: 'medium',
      basis_kind: 'git_ancestry',
      basis_ref: merged.ref,
      basis_sha: row.head_sha,
      reason: `Captured HEAD is contained in integration ref ${merged.ref} but not a production ref`,
      evidence: { ...baseEvidence, checked_refs: [...productionChecks, ...integrationChecks] },
    };
  }

  const integrationPatchMatch = findPatchMatch(input.projectRoot, row, integrationRefs);
  const mergedByPatch = integrationPatchMatch.matches[0];
  if (mergedByPatch) {
    return {
      state: 'merged_unreleased',
      confidence: 'medium',
      basis_kind: 'git_patch_id',
      basis_ref: mergedByPatch.ref,
      basis_sha: mergedByPatch.commit_sha,
      reason: `Captured patch is equivalent to a commit in integration ref ${mergedByPatch.ref} but not a production ref`,
      evidence: {
        ...baseEvidence,
        checked_refs: [...productionChecks, ...integrationChecks],
        patch_match: mergedByPatch,
        patch_scan: {
          max_commits_per_ref: PATCH_SCAN_MAX_COMMITS,
          errors: [...productionPatchMatch.errors, ...integrationPatchMatch.errors],
        },
      },
    };
  }

  const checks = [...productionChecks, ...integrationChecks];
  if (checks.length > 0 && checks.every((check) => check.error)) {
    return {
      state: 'unknown',
      confidence: 'low',
      basis_kind: 'ref_check_failed',
      basis_ref: null,
      basis_sha: row.head_sha,
      reason: 'Configured release refs could not be checked',
      evidence: { ...baseEvidence, checked_refs: checks },
    };
  }

  return {
    state: 'not_on_release_line',
    confidence: 'medium',
    basis_kind: 'git_ancestry',
    basis_ref: null,
    basis_sha: row.head_sha,
    reason: 'Captured HEAD is not contained in configured release refs',
    evidence: { ...baseEvidence, checked_refs: checks },
  };
}

export function reconcileReleaseProvenance(
  input: ReconcileReleaseProvenanceInput,
): ReconcileReleaseProvenanceResult {
  if (!input.config.enabled) {
    return { scanned: 0, reconciled: 0, skipped: 0, disabled: true };
  }

  const now = input.now ?? epochSeconds();
  const rows = listGitProvenance({ scope: input.scope, limit: input.limit ?? 500 });
  const seen = new Set<string>();
  let reconciled = 0;
  let skipped = 0;

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

    const result = classify(row, input);
    upsertReleaseState({
      project_id: input.projectId ?? row.project_id,
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
    reconciled++;
  }

  input.logger?.debug(LOG_KINDS.RELEASE_PROVENANCE_RECONCILE, 'Release provenance reconciled', {
    scanned: rows.length,
    reconciled,
    skipped,
    project_id: input.projectId ?? null,
  });

  return { scanned: rows.length, reconciled, skipped, disabled: false };
}
