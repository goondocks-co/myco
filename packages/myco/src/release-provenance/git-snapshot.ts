import { createHash } from 'node:crypto';
import {
  mergeBase,
  patchIdFromDiff,
  readOptionalRef,
  runGit,
} from './git-cmd.js';

export const PATCH_KINDS = [
  'head',
  'upstream_range',
  'production_range',
  'staged',
  'unstaged',
  'dynamic_range',
] as const;

export type PatchKind = typeof PATCH_KINDS[number];

export interface GitPatchId {
  kind: PatchKind;
  patch_id: string;
  base_ref?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
}

export interface GitSnapshot {
  is_git_repository: boolean;
  project_root: string;
  branch: string | null;
  head_sha: string | null;
  upstream_ref: string | null;
  upstream_sha: string | null;
  production_ref: string | null;
  production_sha: string | null;
  is_dirty: boolean;
  staged_count: number;
  unstaged_count: number;
  untracked_count: number;
  changed_paths: string[];
  tracked_blob_hashes: Record<string, string>;
  patch_ids: GitPatchId[];
  status_hash: string;
  evidence: Record<string, unknown>;
  error: string | null;
}

export interface CaptureGitSnapshotOptions {
  productionRef?: string | null;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface ParsedStatus {
  changedPaths: string[];
  trackedPaths: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

// Parse `git status --porcelain=v2 -z` output. NUL-separated entries avoid the
// rename ambiguity of porcelain v1 (where filenames containing " -> " parse
// wrong). Rename/copy entries carry an extra origin-path field that is NUL-
// separated from the destination path.
function parseStatusV2(statusOutput: string): ParsedStatus {
  const changedPaths = new Set<string>();
  const trackedPaths = new Set<string>();
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  const tokens = statusOutput.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    const recordType = entry[0];
    if (recordType === '1') {
      const fields = entry.split(' ');
      const xy = fields[1] ?? '  ';
      const path = fields.slice(8).join(' ');
      if (!path) continue;
      changedPaths.add(path);
      trackedPaths.add(path);
      if (xy[0] !== '.' && xy[0] !== ' ') stagedCount++;
      if (xy[1] !== '.' && xy[1] !== ' ') unstagedCount++;
    } else if (recordType === '2') {
      const fields = entry.split(' ');
      const xy = fields[1] ?? '  ';
      const path = fields.slice(9).join(' ');
      i++;
      if (!path) continue;
      changedPaths.add(path);
      trackedPaths.add(path);
      if (xy[0] !== '.' && xy[0] !== ' ') stagedCount++;
      if (xy[1] !== '.' && xy[1] !== ' ') unstagedCount++;
    } else if (recordType === '?') {
      const path = entry.slice(2);
      if (!path) continue;
      changedPaths.add(path);
      untrackedCount++;
    } else if (recordType === 'u') {
      const fields = entry.split(' ');
      const path = fields.slice(10).join(' ');
      if (!path) continue;
      changedPaths.add(path);
      trackedPaths.add(path);
      unstagedCount++;
    }
  }

  return {
    changedPaths: [...changedPaths].sort(),
    trackedPaths: [...trackedPaths].sort(),
    stagedCount,
    unstagedCount,
    untrackedCount,
  };
}

function readTrackedBlobHashes(projectRoot: string, trackedPaths: string[]): Record<string, string> {
  if (trackedPaths.length === 0) return {};
  const result = runGit(projectRoot, ['ls-files', '-s', '--', ...trackedPaths]);
  if (!result.ok || !result.stdout) return {};

  const hashes: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+\t(.+)$/.exec(line);
    if (!match) continue;
    hashes[match[3]] = match[2];
  }
  return hashes;
}

function patchIdForDiff(projectRoot: string, kind: PatchKind, diffArgs: string[]): GitPatchId | null {
  const diff = runGit(projectRoot, diffArgs);
  if (!diff.ok || !diff.stdout.trim()) return null;
  const id = patchIdFromDiff(projectRoot, diff.stdout);
  return id ? { kind, patch_id: id } : null;
}

function patchIdForCommit(projectRoot: string, headSha: string | null): GitPatchId | null {
  if (!headSha) return null;
  const diff = runGit(projectRoot, ['show', '--format=', '--patch', '--find-renames', headSha]);
  const id = diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
  return id ? { kind: 'head', patch_id: id, head_sha: headSha } : null;
}

function patchIdForRange(
  projectRoot: string,
  kind: 'upstream_range' | 'production_range',
  baseRef: string | null,
  baseSha: string | null,
  headSha: string | null,
): GitPatchId | null {
  if (!baseSha || !headSha) return null;
  const diff = runGit(projectRoot, ['diff', '--find-renames', baseSha, headSha]);
  const id = diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
  return id ? { kind, patch_id: id, base_ref: baseRef, base_sha: baseSha, head_sha: headSha } : null;
}

export function captureGitSnapshot(projectRoot: string, options: CaptureGitSnapshotOptions = {}): GitSnapshot {
  const inside = runGit(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout !== 'true') {
    const evidence = { git_repository: false, stderr: inside.stderr || null };
    return {
      is_git_repository: false,
      project_root: projectRoot,
      branch: null,
      head_sha: null,
      upstream_ref: null,
      upstream_sha: null,
      production_ref: options.productionRef ?? null,
      production_sha: null,
      is_dirty: false,
      staged_count: 0,
      unstaged_count: 0,
      untracked_count: 0,
      changed_paths: [],
      tracked_blob_hashes: {},
      patch_ids: [],
      status_hash: sha256Json(evidence),
      evidence,
      error: 'not_git_repository',
    };
  }

  const branch = runGit(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = runGit(projectRoot, ['rev-parse', 'HEAD']);
  const upstreamRef = runGit(projectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const upstreamSha = readOptionalRef(projectRoot, '@{u}');
  const productionRef = options.productionRef ?? null;
  const productionSha = productionRef ? readOptionalRef(projectRoot, productionRef) : null;
  const status = runGit(projectRoot, ['status', '--porcelain=v2', '-z']);
  const parsedStatus = parseStatusV2(status.stdout);
  const headSha = head.ok ? head.stdout : null;
  const patchIds = [
    patchIdForCommit(projectRoot, headSha),
    patchIdForRange(
      projectRoot,
      'upstream_range',
      upstreamRef.ok ? upstreamRef.stdout : null,
      mergeBase(projectRoot, headSha, upstreamSha),
      headSha,
    ),
    patchIdForRange(
      projectRoot,
      'production_range',
      productionRef,
      mergeBase(projectRoot, headSha, productionSha),
      headSha,
    ),
    patchIdForDiff(projectRoot, 'staged', ['diff', '--cached']),
    patchIdForDiff(projectRoot, 'unstaged', ['diff']),
  ].filter((entry): entry is GitPatchId => entry !== null);
  const trackedBlobHashes = readTrackedBlobHashes(projectRoot, parsedStatus.trackedPaths);

  const statusBasis = {
    branch: branch.ok ? branch.stdout : null,
    head_sha: headSha,
    upstream_ref: upstreamRef.ok ? upstreamRef.stdout : null,
    upstream_sha: upstreamSha,
    production_ref: productionRef,
    production_sha: productionSha,
    staged_count: parsedStatus.stagedCount,
    unstaged_count: parsedStatus.unstagedCount,
    untracked_count: parsedStatus.untrackedCount,
    changed_paths: parsedStatus.changedPaths,
    tracked_blob_hashes: trackedBlobHashes,
    patch_ids: patchIds,
  };

  return {
    is_git_repository: true,
    project_root: projectRoot,
    branch: branch.ok ? branch.stdout : null,
    head_sha: headSha,
    upstream_ref: upstreamRef.ok ? upstreamRef.stdout : null,
    upstream_sha: upstreamSha,
    production_ref: productionRef,
    production_sha: productionSha,
    is_dirty: parsedStatus.changedPaths.length > 0,
    staged_count: parsedStatus.stagedCount,
    unstaged_count: parsedStatus.unstagedCount,
    untracked_count: parsedStatus.untrackedCount,
    changed_paths: parsedStatus.changedPaths,
    tracked_blob_hashes: trackedBlobHashes,
    patch_ids: patchIds,
    status_hash: sha256Json(statusBasis),
    evidence: {
      git_repository: true,
      status_basis: statusBasis,
    },
    error: status.ok ? null : 'git_status_failed',
  };
}
