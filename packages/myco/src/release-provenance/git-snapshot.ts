import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5_000;

export interface GitPatchId {
  kind: 'head' | 'upstream_range' | 'production_range' | 'staged' | 'unstaged';
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

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runGit(projectRoot: string, args: string[], input?: string): GitCommandResult {
  try {
    const stdout = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: '' };
  } catch (err) {
    const failure = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: String(failure.stdout ?? '').trimEnd(),
      stderr: String(failure.stderr ?? failure.message ?? '').trimEnd(),
    };
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseStatusPath(line: string): { path: string; untracked: boolean; staged: boolean; unstaged: boolean } | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  const rawPath = line.slice(3);
  const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').at(-1)! : rawPath;
  return {
    path,
    untracked: status === '??',
    staged: status[0] !== ' ' && status[0] !== '?',
    unstaged: status[1] !== ' ' && status[1] !== '?',
  };
}

function parseStatus(statusOutput: string): {
  changedPaths: string[];
  trackedPaths: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
} {
  const changedPaths = new Set<string>();
  const trackedPaths = new Set<string>();
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const line of statusOutput.split('\n')) {
    if (!line) continue;
    const parsed = parseStatusPath(line);
    if (!parsed) continue;
    changedPaths.add(parsed.path);
    if (parsed.untracked) {
      untrackedCount++;
    } else {
      trackedPaths.add(parsed.path);
      if (parsed.staged) stagedCount++;
      if (parsed.unstaged) unstagedCount++;
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

function patchIdFromDiff(projectRoot: string, diffOutput: string): string | null {
  if (!diffOutput.trim()) return null;
  const patchId = runGit(projectRoot, ['patch-id', '--stable'], `${diffOutput}\n`);
  if (!patchId.ok || !patchId.stdout.trim()) return null;
  return patchId.stdout.trim().split(/\s+/)[0] ?? null;
}

function patchIdForDiff(projectRoot: string, kind: GitPatchId['kind'], diffArgs: string[]): GitPatchId | null {
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

function readOptionalRef(projectRoot: string, ref: string): string | null {
  const result = runGit(projectRoot, ['rev-parse', ref]);
  return result.ok && result.stdout ? result.stdout : null;
}

function mergeBase(projectRoot: string, left: string | null, right: string | null): string | null {
  if (!left || !right) return null;
  const result = runGit(projectRoot, ['merge-base', left, right]);
  return result.ok && result.stdout ? result.stdout : null;
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
  const status = runGit(projectRoot, ['status', '--porcelain=v1']);
  const parsedStatus = parseStatus(status.stdout);
  const patchIds = [
    patchIdForCommit(projectRoot, head.ok ? head.stdout : null),
    patchIdForRange(
      projectRoot,
      'upstream_range',
      upstreamRef.ok ? upstreamRef.stdout : null,
      mergeBase(projectRoot, head.ok ? head.stdout : null, upstreamSha),
      head.ok ? head.stdout : null,
    ),
    patchIdForRange(
      projectRoot,
      'production_range',
      productionRef,
      mergeBase(projectRoot, head.ok ? head.stdout : null, productionSha),
      head.ok ? head.stdout : null,
    ),
    patchIdForDiff(projectRoot, 'staged', ['diff', '--cached']),
    patchIdForDiff(projectRoot, 'unstaged', ['diff']),
  ].filter((entry): entry is GitPatchId => entry !== null);
  const trackedBlobHashes = readTrackedBlobHashes(projectRoot, parsedStatus.trackedPaths);

  const statusBasis = {
    branch: branch.ok ? branch.stdout : null,
    head_sha: head.ok ? head.stdout : null,
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
    head_sha: head.ok ? head.stdout : null,
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
      status_porcelain: status.stdout,
      status_basis: statusBasis,
    },
    error: status.ok ? null : 'git_status_failed',
  };
}
