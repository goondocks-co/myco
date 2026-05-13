// Lightweight git state for the topbar identity pill. Reads branch, dirty
// flag, ahead/behind, head sha, and last-commit author from the request's
// project root — NOT the daemon's working directory. The daemon serves
// multiple projects; scoping to req.requestContext.projectRoot is what
// keeps a Grove with N projects from reporting one canonical branch.
//
// Heavier git work (patch IDs, blob hashes) lives in release-provenance;
// this endpoint stays cheap so a 30s topbar poll doesn't compete with it.

import { spawnSync } from 'node:child_process';
import type { RouteHandler, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';

// Cap subprocess wall time so a wedged index.lock or slow NFS doesn't
// pin a daemon route. The topbar consumer treats 404 the same as
// "no git here" — a timeout is no worse than that.
const GIT_TIMEOUT_MS = 2000;

function notFound(reason: string): RouteResponse {
  return { status: 404, body: errorBody('not_found', reason) };
}

function badRequest(reason: string): RouteResponse {
  return { status: 400, body: errorBody('bad_request', reason) };
}

export interface GitStatusResponse {
  branch: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  author: string;
  author_email: string;
  head_sha: string;
}

export interface ParsedGitStatus {
  branch: string;
  head_sha: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/**
 * Parse `git status --porcelain=v2 --branch` output.
 *
 * Header lines begin with `# branch.<key> <value>`; everything else is an
 * entry line (one per modified/untracked/unmerged path). Any non-header,
 * non-empty line means the worktree is dirty — we don't classify, the
 * topbar only needs the boolean.
 */
export function parseGitStatus(porcelainOutput: string): ParsedGitStatus {
  const lines = porcelainOutput.split('\n');
  let branch = '';
  let head_sha = '';
  let ahead = 0;
  let behind = 0;
  let dirty = false;

  for (const line of lines) {
    if (line.startsWith('# branch.oid ')) {
      head_sha = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const ab = line.slice('# branch.ab '.length).trim();
      const match = ab.match(/^\+(\d+)\s+-(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.length > 0 && !line.startsWith('#')) {
      dirty = true;
    }
  }

  return { branch, head_sha, dirty, ahead, behind };
}

/**
 * Run git in `cwd` and return the topbar-shaped status, or null if the
 * directory isn't a git repo (or git isn't installed). The two spawns
 * are kept separate so a missing HEAD (fresh repo, no commits yet)
 * downgrades the author fields to empty strings instead of failing
 * the whole call.
 */
export function readGitStatus(cwd: string): GitStatusResponse | null {
  const statusResult = spawnSync('git', ['status', '--porcelain=v2', '--branch'], {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  // SpawnSyncReturns sets `signal` (non-null) when the child was killed by
  // the timeout, and leaves `status` at null. The old `status !== 0` check
  // alone let the timeout case fall through to a successful response.
  if (statusResult.error || statusResult.signal !== null || statusResult.status !== 0) return null;

  const authorResult = spawnSync('git', ['log', '-1', '--pretty=%an%n%ae'], {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  // Author lookup is best-effort: a timed-out or failed `git log` (fresh
  // repo with no commits, slow NFS) downgrades to empty author fields
  // rather than failing the whole call.
  const authorStdout = (!authorResult.error && authorResult.signal === null && authorResult.status === 0)
    ? (authorResult.stdout ?? '')
    : '';
  const [author = '', author_email = ''] = authorStdout.split('\n');

  const parsed = parseGitStatus(statusResult.stdout ?? '');
  return {
    ...parsed,
    author: author.trim(),
    author_email: author_email.trim(),
  };
}

/**
 * GET /api/git/status — returns the request project's git state.
 *
 * Scopes to `req.requestContext.projectRoot`, not `process.cwd()`: the
 * daemon serves multiple projects, and a Grove switch must change the
 * reported branch immediately.
 */
export const handleGetGitStatus: RouteHandler = async (req) => {
  const projectRoot = req.requestContext?.projectRoot;
  if (!projectRoot) return badRequest('Request has no project root');
  const status = readGitStatus(projectRoot);
  if (!status) return notFound('Not a git repository or git is unavailable');
  return { body: status };
};
