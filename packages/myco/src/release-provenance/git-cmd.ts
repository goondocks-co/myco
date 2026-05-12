/**
 * Shared Git execution helpers for release provenance.
 *
 * Both capture (git-snapshot.ts) and reconciliation (reconcile.ts) shell out
 * to `git` for the same set of operations. They share this module so the
 * timeout, error shape, and command shape stay in lock-step.
 */

import { execFileSync } from 'node:child_process';

export const GIT_TIMEOUT_MS = 5_000;

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  status?: number;
}

export function runGit(projectRoot: string, args: string[], input?: string): GitCommandResult {
  try {
    const stdout = execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      input,
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: '' };
  } catch (err) {
    const failure = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string; status?: number };
    return {
      ok: false,
      stdout: String(failure.stdout ?? '').trimEnd(),
      stderr: String(failure.stderr ?? failure.message ?? '').trimEnd(),
      error: failure.message,
      status: failure.status,
    };
  }
}

export function patchIdFromDiff(projectRoot: string, diffOutput: string): string | null {
  if (!diffOutput.trim()) return null;
  const patchId = runGit(projectRoot, ['patch-id', '--stable'], `${diffOutput}\n`);
  if (!patchId.ok || !patchId.stdout.trim()) return null;
  return patchId.stdout.trim().split(/\s+/)[0] ?? null;
}

export function patchIdForCommit(projectRoot: string, commitSha: string): string | null {
  const diff = runGit(projectRoot, ['show', '--format=', '--patch', '--find-renames', commitSha]);
  return diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
}

export function patchIdForRange(projectRoot: string, baseSha: string, headSha: string): string | null {
  const diff = runGit(projectRoot, ['diff', '--find-renames', baseSha, headSha]);
  return diff.ok ? patchIdFromDiff(projectRoot, diff.stdout) : null;
}

export function mergeBase(projectRoot: string, left: string | null, right: string | null): string | null {
  if (!left || !right) return null;
  const result = runGit(projectRoot, ['merge-base', left, right]);
  return result.ok && result.stdout ? result.stdout : null;
}

export function readOptionalRef(projectRoot: string, ref: string): string | null {
  const result = runGit(projectRoot, ['rev-parse', ref]);
  return result.ok && result.stdout ? result.stdout : null;
}
