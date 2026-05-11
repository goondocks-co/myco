import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5_000;

export interface GitPatchId {
  kind: 'staged' | 'unstaged';
  patch_id: string;
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

function patchIdForDiff(projectRoot: string, kind: GitPatchId['kind'], diffArgs: string[]): GitPatchId | null {
  const diff = runGit(projectRoot, diffArgs);
  if (!diff.ok || !diff.stdout.trim()) return null;
  const patchId = runGit(projectRoot, ['patch-id', '--stable'], `${diff.stdout}\n`);
  if (!patchId.ok || !patchId.stdout.trim()) return null;
  const id = patchId.stdout.trim().split(/\s+/)[0];
  return id ? { kind, patch_id: id } : null;
}

function readOptionalRef(projectRoot: string, ref: string): string | null {
  const result = runGit(projectRoot, ['rev-parse', ref]);
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
