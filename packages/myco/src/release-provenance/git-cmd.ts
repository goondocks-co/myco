/**
 * Shared Git execution helpers for release provenance.
 *
 * Both capture (git-snapshot.ts) and reconciliation (reconcile.ts) shell out
 * to `git` for the same set of operations. They share this module so the
 * timeout, error shape, and command shape stay in lock-step.
 */

import { execFileSync, spawn } from 'node:child_process';

export const GIT_TIMEOUT_MS = 5_000;

// execFileSync caps stdout at 1 MiB by default and throws ENOBUFS past it,
// silently turning large `git show`/`git log -p` output into ok:false. The
// spawn-based runGitAsync has no such cap, so the sync path must match or the
// two diverge on big diffs (a PR merge commit's patch, a large/generated-file
// commit). Capture-time patch-id runs through the sync path, so a silent cap
// drops provenance for large commits. 256 MiB mirrors the async path's
// effectively-unbounded read while staying under V8's max string length.
export const GIT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

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
      maxBuffer: GIT_MAX_BUFFER_BYTES,
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

// --- Async variants (non-blocking; for use in reconcile hot path) ---

export function runGitAsync(projectRoot: string, args: string[], input?: string): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', projectRoot, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    // Accumulate raw bytes and decode the COMPLETE stream once at the end.
    // `string += chunk` decodes each chunk as UTF-8 independently, which mangles
    // any multi-byte sequence split across a chunk boundary into U+FFFD — so
    // async output silently diverged from runGit on diffs containing non-ASCII
    // (corrupting patch-ids in the reconcile path). Buffer.concat + decode
    // matches execFileSync's whole-output decode.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const decodeOut = () => Buffer.concat(stdoutChunks).toString('utf8').trimEnd();
    const decodeErr = () => Buffer.concat(stderrChunks).toString('utf8').trimEnd();
    const finish = (r: GitCommandResult) => { if (!settled) { settled = true; resolve(r); } };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, stdout: decodeOut(), stderr: `git timed out after ${GIT_TIMEOUT_MS}ms`, error: 'ETIMEDOUT' });
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdoutChunks.push(d); });
    child.stderr.on('data', (d: Buffer) => { stderrChunks.push(d); });
    child.on('error', (err: Error) => { clearTimeout(timer); finish({ ok: false, stdout: '', stderr: String(err.message), error: err.message }); });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish(code === 0
        ? { ok: true, stdout: decodeOut(), stderr: '' }
        : { ok: false, stdout: decodeOut(), stderr: decodeErr(), error: `git exited ${code}`, status: code ?? undefined });
    });

    child.stdin.on('error', () => { /* ignore stdin EPIPE when child exits/killed mid-write */ });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export async function patchIdFromDiffAsync(projectRoot: string, diffOutput: string): Promise<string | null> {
  if (!diffOutput.trim()) return null;
  const patchId = await runGitAsync(projectRoot, ['patch-id', '--stable'], `${diffOutput}\n`);
  if (!patchId.ok || !patchId.stdout.trim()) return null;
  return patchId.stdout.trim().split(/\s+/)[0] ?? null;
}

export async function patchIdForCommitAsync(projectRoot: string, commitSha: string): Promise<string | null> {
  const diff = await runGitAsync(projectRoot, ['show', '--format=', '--patch', '--find-renames', commitSha]);
  return diff.ok ? patchIdFromDiffAsync(projectRoot, diff.stdout) : null;
}

export async function patchIdForRangeAsync(projectRoot: string, baseSha: string, headSha: string): Promise<string | null> {
  const diff = await runGitAsync(projectRoot, ['diff', '--find-renames', baseSha, headSha]);
  return diff.ok ? patchIdFromDiffAsync(projectRoot, diff.stdout) : null;
}

export async function mergeBaseAsync(projectRoot: string, left: string | null, right: string | null): Promise<string | null> {
  if (!left || !right) return null;
  const result = await runGitAsync(projectRoot, ['merge-base', left, right]);
  return result.ok && result.stdout ? result.stdout : null;
}
