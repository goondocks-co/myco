/**
 * Release-provenance query helpers.
 *
 * Raw Git provenance is factual evidence captured from the local repo.
 * Release state is derived and rebuildable, so callers upsert it by
 * (project scope, namespace, record_id) rather than mutating source rows.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';

export const RELEASE_CAPTURE_POINTS = [
  'session_start',
  'session_end',
  'prompt_batch_start',
  'prompt_batch_stop',
] as const;

export type ReleaseCapturePoint = typeof RELEASE_CAPTURE_POINTS[number];

export const RELEASE_STATES = [
  'unreconciled',
  'released',
  'merged_unreleased',
  'not_on_release_line',
  'unknown',
] as const;

export type ReleaseStateValue = typeof RELEASE_STATES[number];

export const RELEASE_CONFIDENCE = ['high', 'medium', 'low'] as const;

export type ReleaseConfidence = typeof RELEASE_CONFIDENCE[number];

export const RELEASE_NAMESPACES = [
  'sessions',
  'prompt_batches',
  'spores',
  'plans',
  'artifacts',
  'skill_records',
  'canopy_entries',
] as const;

export type ReleaseNamespace = typeof RELEASE_NAMESPACES[number];

export const RELEASE_BASIS_KINDS = [
  'git_ancestry',
  'git_patch_id',
  'github_pr_squash',
  'dirty_worktree',
  'configuration',
  'missing_git_evidence',
  'ref_check_failed',
] as const;

export type ReleaseBasisKind = typeof RELEASE_BASIS_KINDS[number];

const CAPTURE_POINT_SET = new Set<string>(RELEASE_CAPTURE_POINTS);
const RELEASE_STATE_SET = new Set<string>(RELEASE_STATES);
const RELEASE_CONFIDENCE_SET = new Set<string>(RELEASE_CONFIDENCE);
const RELEASE_NAMESPACE_SET = new Set<string>(RELEASE_NAMESPACES);

export interface GitProvenanceInsert {
  project_id?: string | null;
  machine_id?: string;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  capture_point: ReleaseCapturePoint;
  captured_at: number;
  project_root?: string | null;
  branch?: string | null;
  head_sha?: string | null;
  upstream_ref?: string | null;
  upstream_sha?: string | null;
  production_ref?: string | null;
  production_sha?: string | null;
  is_dirty?: number | boolean;
  staged_count?: number;
  unstaged_count?: number;
  untracked_count?: number;
  changed_paths_json?: string | null;
  tracked_blob_hashes_json?: string | null;
  patch_ids_json?: string | null;
  status_hash: string;
  evidence_json?: string | null;
  error?: string | null;
  created_at: number;
}

export interface GitProvenanceRow extends Required<Omit<GitProvenanceInsert,
  'project_id' | 'machine_id' | 'session_id' | 'prompt_batch_id' | 'project_root'
  | 'branch' | 'head_sha' | 'upstream_ref' | 'upstream_sha' | 'production_ref'
  | 'production_sha' | 'changed_paths_json' | 'tracked_blob_hashes_json'
  | 'patch_ids_json' | 'evidence_json' | 'error' | 'is_dirty'
> > {
  id: number;
  project_id: string | null;
  machine_id: string;
  identity_key: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  project_root: string | null;
  branch: string | null;
  head_sha: string | null;
  upstream_ref: string | null;
  upstream_sha: string | null;
  production_ref: string | null;
  production_sha: string | null;
  is_dirty: number;
  changed_paths_json: string | null;
  tracked_blob_hashes_json: string | null;
  patch_ids_json: string | null;
  evidence_json: string | null;
  error: string | null;
}

export interface ReleaseStateUpsert {
  project_id?: string | null;
  machine_id?: string;
  namespace: ReleaseNamespace;
  record_id: string;
  source_session_id?: string | null;
  source_prompt_batch_id?: number | null;
  state: ReleaseStateValue;
  confidence: ReleaseConfidence;
  basis_kind?: string | null;
  basis_ref?: string | null;
  basis_sha?: string | null;
  release_pr_number?: number | null;
  reason?: string | null;
  evidence_json?: string | null;
  checked_at: number;
  created_at: number;
  updated_at?: number | null;
}

export interface ReleaseStateRow extends Required<Omit<ReleaseStateUpsert,
  'project_id' | 'machine_id' | 'source_session_id' | 'source_prompt_batch_id'
  | 'basis_kind' | 'basis_ref' | 'basis_sha' | 'release_pr_number' | 'reason'
  | 'evidence_json' | 'updated_at'
> > {
  id: number;
  project_id: string | null;
  machine_id: string;
  identity_key: string;
  source_session_id: string | null;
  source_prompt_batch_id: number | null;
  basis_kind: string | null;
  basis_ref: string | null;
  basis_sha: string | null;
  release_pr_number: number | null;
  reason: string | null;
  evidence_json: string | null;
  updated_at: number | null;
  /** Epoch seconds when this row was handed off to the team sync outbox.
   * `null` means the row has never been enqueued — either team sync was
   * disabled when it was written, or the write predates that integration.
   * The reconciler treats `null` as a sync-debt signal and re-enqueues even
   * when classification is unchanged. */
  synced_at: number | null;
}

export interface ListGitProvenanceOptions {
  scope: ProjectScope;
  session_id?: string;
  prompt_batch_id?: number;
  capture_point?: ReleaseCapturePoint;
  head_sha?: string;
  limit?: number;
  db?: Database;
}

export interface ListReleaseStateOptions {
  scope: ProjectScope;
  namespace?: ReleaseNamespace;
  record_id?: string;
  state?: ReleaseStateValue;
  confidence?: ReleaseConfidence;
  source_session_id?: string;
  source_prompt_batch_id?: number;
  checked_before?: number;
  limit?: number;
  db?: Database;
}

function assertKnown(value: string, allowed: Set<string>, label: string): void {
  if (!allowed.has(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function projectIdentityPart(projectId: string | null | undefined): string {
  return projectId ?? 'global';
}

export function buildGitProvenanceIdentityKey(input: {
  project_id?: string | null;
  session_id?: string | null;
  prompt_batch_id?: number | null;
  capture_point: ReleaseCapturePoint;
  status_hash: string;
}): string {
  return [
    projectIdentityPart(input.project_id),
    input.session_id ?? '',
    input.prompt_batch_id ?? '',
    input.capture_point,
    input.status_hash,
  ].join(':');
}

export function buildReleaseStateIdentityKey(input: {
  project_id?: string | null;
  namespace: ReleaseNamespace;
  record_id: string;
}): string {
  return [projectIdentityPart(input.project_id), input.namespace, input.record_id].join(':');
}

function toGitProvenanceRow(row: Record<string, unknown>): GitProvenanceRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    machine_id: (row.machine_id as string) ?? 'local',
    identity_key: row.identity_key as string,
    session_id: (row.session_id as string) ?? null,
    prompt_batch_id: (row.prompt_batch_id as number) ?? null,
    capture_point: row.capture_point as ReleaseCapturePoint,
    captured_at: row.captured_at as number,
    project_root: (row.project_root as string) ?? null,
    branch: (row.branch as string) ?? null,
    head_sha: (row.head_sha as string) ?? null,
    upstream_ref: (row.upstream_ref as string) ?? null,
    upstream_sha: (row.upstream_sha as string) ?? null,
    production_ref: (row.production_ref as string) ?? null,
    production_sha: (row.production_sha as string) ?? null,
    is_dirty: (row.is_dirty as number) ?? 0,
    staged_count: (row.staged_count as number) ?? 0,
    unstaged_count: (row.unstaged_count as number) ?? 0,
    untracked_count: (row.untracked_count as number) ?? 0,
    changed_paths_json: (row.changed_paths_json as string) ?? null,
    tracked_blob_hashes_json: (row.tracked_blob_hashes_json as string) ?? null,
    patch_ids_json: (row.patch_ids_json as string) ?? null,
    status_hash: row.status_hash as string,
    evidence_json: (row.evidence_json as string) ?? null,
    error: (row.error as string) ?? null,
    created_at: row.created_at as number,
  };
}

function toReleaseStateRow(row: Record<string, unknown>): ReleaseStateRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    machine_id: (row.machine_id as string) ?? 'local',
    identity_key: row.identity_key as string,
    namespace: row.namespace as ReleaseNamespace,
    record_id: row.record_id as string,
    source_session_id: (row.source_session_id as string) ?? null,
    source_prompt_batch_id: (row.source_prompt_batch_id as number) ?? null,
    state: row.state as ReleaseStateValue,
    confidence: row.confidence as ReleaseConfidence,
    basis_kind: (row.basis_kind as string) ?? null,
    basis_ref: (row.basis_ref as string) ?? null,
    basis_sha: (row.basis_sha as string) ?? null,
    release_pr_number: (row.release_pr_number as number) ?? null,
    reason: (row.reason as string) ?? null,
    evidence_json: (row.evidence_json as string) ?? null,
    checked_at: row.checked_at as number,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
    synced_at: (row.synced_at as number) ?? null,
  };
}

export function gitProvenanceExists(identityKey: string, dbArg?: Database): boolean {
  const db = dbArg ?? getDatabase();
  const row = db.prepare(
    'SELECT 1 FROM knowledge_git_provenance WHERE identity_key = ? LIMIT 1',
  ).get(identityKey);
  return row !== undefined && row !== null;
}

export function insertGitProvenance(input: GitProvenanceInsert, dbArg?: Database): GitProvenanceRow {
  assertKnown(input.capture_point, CAPTURE_POINT_SET, 'release provenance capture_point');
  if (!input.status_hash) throw new Error('status_hash is required');

  const db = dbArg ?? getDatabase();
  const identityKey = buildGitProvenanceIdentityKey(input);
  db.prepare(
    `INSERT INTO knowledge_git_provenance (
       project_id, machine_id, identity_key, session_id, prompt_batch_id,
       capture_point, captured_at, project_root, branch, head_sha,
       upstream_ref, upstream_sha, production_ref, production_sha,
       is_dirty, staged_count, unstaged_count, untracked_count,
       changed_paths_json, tracked_blob_hashes_json, patch_ids_json,
       status_hash, evidence_json, error, created_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
       ?, ?, ?, ?
     )
     ON CONFLICT (identity_key) DO UPDATE SET
       captured_at              = EXCLUDED.captured_at,
       project_root             = EXCLUDED.project_root,
       branch                   = EXCLUDED.branch,
       head_sha                 = EXCLUDED.head_sha,
       upstream_ref             = EXCLUDED.upstream_ref,
       upstream_sha             = EXCLUDED.upstream_sha,
       production_ref           = EXCLUDED.production_ref,
       production_sha           = EXCLUDED.production_sha,
       is_dirty                 = EXCLUDED.is_dirty,
       staged_count             = EXCLUDED.staged_count,
       unstaged_count           = EXCLUDED.unstaged_count,
       untracked_count          = EXCLUDED.untracked_count,
       changed_paths_json       = EXCLUDED.changed_paths_json,
       tracked_blob_hashes_json = EXCLUDED.tracked_blob_hashes_json,
       patch_ids_json           = EXCLUDED.patch_ids_json,
       evidence_json            = EXCLUDED.evidence_json,
       error                    = EXCLUDED.error`,
  ).run(
    input.project_id ?? null,
    input.machine_id ?? getTeamMachineId(),
    identityKey,
    input.session_id ?? null,
    input.prompt_batch_id ?? null,
    input.capture_point,
    input.captured_at,
    input.project_root ?? null,
    input.branch ?? null,
    input.head_sha ?? null,
    input.upstream_ref ?? null,
    input.upstream_sha ?? null,
    input.production_ref ?? null,
    input.production_sha ?? null,
    input.is_dirty === true ? 1 : Number(input.is_dirty ?? 0),
    input.staged_count ?? 0,
    input.unstaged_count ?? 0,
    input.untracked_count ?? 0,
    input.changed_paths_json ?? null,
    input.tracked_blob_hashes_json ?? null,
    input.patch_ids_json ?? null,
    input.status_hash,
    input.evidence_json ?? null,
    input.error ?? null,
    input.created_at,
  );

  const row = db.prepare(
    'SELECT * FROM knowledge_git_provenance WHERE identity_key = ?',
  ).get(identityKey) as Record<string, unknown>;
  return toGitProvenanceRow(row);
}

export function upsertReleaseState(input: ReleaseStateUpsert, dbArg?: Database): ReleaseStateRow {
  assertKnown(input.namespace, RELEASE_NAMESPACE_SET, 'release namespace');
  assertKnown(input.state, RELEASE_STATE_SET, 'release state');
  assertKnown(input.confidence, RELEASE_CONFIDENCE_SET, 'release confidence');
  if (!input.record_id) throw new Error('record_id is required');

  const db = dbArg ?? getDatabase();
  const identityKey = buildReleaseStateIdentityKey(input);
  db.prepare(
    `INSERT INTO knowledge_release_state (
       project_id, machine_id, identity_key, namespace, record_id,
       source_session_id, source_prompt_batch_id, state, confidence,
       basis_kind, basis_ref, basis_sha, release_pr_number,
       reason, evidence_json, checked_at, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )
     ON CONFLICT (identity_key) DO UPDATE SET
       machine_id              = EXCLUDED.machine_id,
       source_session_id       = EXCLUDED.source_session_id,
       source_prompt_batch_id  = EXCLUDED.source_prompt_batch_id,
       state                   = EXCLUDED.state,
       confidence              = EXCLUDED.confidence,
       basis_kind              = EXCLUDED.basis_kind,
       basis_ref               = EXCLUDED.basis_ref,
       basis_sha               = EXCLUDED.basis_sha,
       release_pr_number       = EXCLUDED.release_pr_number,
       reason                  = EXCLUDED.reason,
       evidence_json           = EXCLUDED.evidence_json,
       checked_at              = EXCLUDED.checked_at,
       updated_at              = EXCLUDED.updated_at`,
  ).run(
    input.project_id ?? null,
    input.machine_id ?? getTeamMachineId(),
    identityKey,
    input.namespace,
    input.record_id,
    input.source_session_id ?? null,
    input.source_prompt_batch_id ?? null,
    input.state,
    input.confidence,
    input.basis_kind ?? null,
    input.basis_ref ?? null,
    input.basis_sha ?? null,
    input.release_pr_number ?? null,
    input.reason ?? null,
    input.evidence_json ?? null,
    input.checked_at,
    input.created_at,
    input.updated_at ?? input.checked_at,
  );

  const row = db.prepare(
    'SELECT * FROM knowledge_release_state WHERE identity_key = ?',
  ).get(identityKey) as Record<string, unknown>;
  const releaseState = toReleaseStateRow(row);
  syncRow('knowledge_release_state', releaseState);
  return releaseState;
}

/**
 * Bump checked_at on an existing release-state row without rewriting the
 * derived classification fields. Used when reconciliation re-evaluates a row
 * and reaches the same conclusion — avoids needless team-outbox churn.
 */
export function touchReleaseStateCheckedAt(identityKey: string, checkedAt: number, dbArg?: Database): void {
  const db = dbArg ?? getDatabase();
  db.prepare(
    'UPDATE knowledge_release_state SET checked_at = ? WHERE identity_key = ?',
  ).run(checkedAt, identityKey);
}

export function getReleaseStateByIdentityKey(identityKey: string, dbArg?: Database): ReleaseStateRow | null {
  const db = dbArg ?? getDatabase();
  const row = db.prepare(
    'SELECT * FROM knowledge_release_state WHERE identity_key = ?',
  ).get(identityKey) as Record<string, unknown> | undefined;
  return row ? toReleaseStateRow(row) : null;
}

export function getReleaseState(
  namespace: ReleaseNamespace,
  recordId: string,
  scope: ProjectScope,
  dbArg?: Database,
): ReleaseStateRow | null {
  assertKnown(namespace, RELEASE_NAMESPACE_SET, 'release namespace');
  const db = dbArg ?? getDatabase();
  const conditions = ['namespace = ?', 'record_id = ?'];
  const params: unknown[] = [namespace, recordId];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT * FROM knowledge_release_state WHERE ${conditions.join(' AND ')} LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toReleaseStateRow(row) : null;
}

/**
 * Bulk-fetch release-state annotations for many record_ids in a single
 * namespace. Used by search hydration to avoid an N+1 lookup per result row.
 *
 * Returns a Map keyed by record_id; absent ids simply don't appear in the
 * map. Empty input returns an empty map without hitting SQLite.
 */
export function getReleaseStatesForRecords(
  namespace: ReleaseNamespace,
  recordIds: readonly string[],
  scope: ProjectScope,
  dbArg?: Database,
): Map<string, ReleaseStateRow> {
  const out = new Map<string, ReleaseStateRow>();
  if (recordIds.length === 0) return out;
  assertKnown(namespace, RELEASE_NAMESPACE_SET, 'release namespace');
  const db = dbArg ?? getDatabase();
  const conditions = ['namespace = ?', `record_id IN (SELECT value FROM json_each(?))`];
  const params: unknown[] = [namespace, JSON.stringify([...new Set(recordIds)])];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT * FROM knowledge_release_state WHERE ${conditions.join(' AND ')}`,
  ).all(...params) as Array<Record<string, unknown>>;
  for (const raw of rows) {
    const row = toReleaseStateRow(raw);
    out.set(row.record_id, row);
  }
  return out;
}

export function listGitProvenance(options: ListGitProvenanceOptions): GitProvenanceRow[] {
  if (options.capture_point) assertKnown(options.capture_point, CAPTURE_POINT_SET, 'release provenance capture_point');
  const db = options.db ?? getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, options.scope);
  if (options.session_id) {
    conditions.push('session_id = ?');
    params.push(options.session_id);
  }
  if (options.prompt_batch_id !== undefined) {
    conditions.push('prompt_batch_id = ?');
    params.push(options.prompt_batch_id);
  }
  if (options.capture_point) {
    conditions.push('capture_point = ?');
    params.push(options.capture_point);
  }
  if (options.head_sha) {
    conditions.push('head_sha = ?');
    params.push(options.head_sha);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = db.prepare(
    `SELECT * FROM knowledge_git_provenance ${where}
     ORDER BY captured_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(toGitProvenanceRow);
}

export function listReleaseStates(options: ListReleaseStateOptions): ReleaseStateRow[] {
  if (options.namespace) assertKnown(options.namespace, RELEASE_NAMESPACE_SET, 'release namespace');
  if (options.state) assertKnown(options.state, RELEASE_STATE_SET, 'release state');
  if (options.confidence) assertKnown(options.confidence, RELEASE_CONFIDENCE_SET, 'release confidence');

  const db = options.db ?? getDatabase();
  const conditions: string[] = [];
  const params: unknown[] = [];
  appendProjectCondition(conditions, params, options.scope);
  if (options.namespace) {
    conditions.push('namespace = ?');
    params.push(options.namespace);
  }
  if (options.record_id) {
    conditions.push('record_id = ?');
    params.push(options.record_id);
  }
  if (options.state) {
    conditions.push('state = ?');
    params.push(options.state);
  }
  if (options.confidence) {
    conditions.push('confidence = ?');
    params.push(options.confidence);
  }
  if (options.source_session_id) {
    conditions.push('source_session_id = ?');
    params.push(options.source_session_id);
  }
  if (options.source_prompt_batch_id !== undefined) {
    conditions.push('source_prompt_batch_id = ?');
    params.push(options.source_prompt_batch_id);
  }
  if (options.checked_before !== undefined) {
    conditions.push('checked_at < ?');
    params.push(options.checked_before);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const rows = db.prepare(
    `SELECT * FROM knowledge_release_state ${where}
     ORDER BY checked_at DESC, id DESC
     LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(toReleaseStateRow);
}
