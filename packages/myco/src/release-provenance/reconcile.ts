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

interface ReleaseTarget {
  namespace: ReleaseNamespace;
  recordId: string;
}

interface RefCheck {
  ref: string;
  ok: boolean;
  error?: string;
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

function runGit(projectRoot: string, args: string[]): { ok: boolean; stdout: string; error?: string } {
  try {
    const stdout = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: '', error: (err as Error).message };
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
    return { ref, ok: result.ok, ...(result.ok ? {} : { error: result.error }) };
  });
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
