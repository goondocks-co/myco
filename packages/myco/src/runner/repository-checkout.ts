import { withRepositoryMirror, type RepositoryMirror } from './repository-cache.js';
import { parseRepositoryFailure } from '@goondocks/myco-shared/run-text';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repositoryUrl, repositoryBranch, REPOSITORY_COMMIT_PATTERN as SHA_PATTERN, MAX_REPOSITORY_HISTORY_DEPTH, REPOSITORY_PREPARATION_TIMEOUT_MS, MAX_REPOSITORY_COMPARISON_BYTES, MAX_REPOSITORY_CHANGED_PATHS, parseRepositoryChanges, type RepositoryChange, type RepositoryFailure, type RepositoryFailureCode } from '@goondocks/myco-shared/repository';

export { repositoryUrl } from '@goondocks/myco-shared/repository';

const MAX_GIT_OUTPUT_BYTES = 1_000_000;
export const MAX_REPOSITORY_BYTES = 256 * 1024 * 1024;
export const CHECKOUT_TIMEOUT_MS = REPOSITORY_PREPARATION_TIMEOUT_MS;
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

/** A checkout refusal carries only a closed reason and a sanitized Git summary. */
export class RepositoryCheckoutError extends Error {
  readonly failure: RepositoryFailure;
  constructor(code: RepositoryFailureCode, message: string, summary?: string, secrets: readonly string[] = []) {
    super(message);
    this.name = 'RepositoryCheckoutError';
    this.failure = parseRepositoryFailure({ code, summary }, secrets)!;
  }
}

export interface RepositoryCheckoutRequest {
  url: string;
  branch: string;
  credential?: { username: string; token: string };
  commit?: string;
  /** Prior map commit whose changed paths are needed for incremental discovery. */
  compareCommit?: string;
  signal: AbortSignal;
  /** Persist the resolved commit before any file is exposed to a task. */
  pin: (commit: string) => Promise<string>;
  /** Executable override for runtime packaging and integration fixtures. */
  gitPath?: string;
  /** A new directory owned by the caller's run; an existing path is refused. */
  destination?: string;
  /** Caller-owned destinations use their disposal authority when supplied. */
  removeDestination?: () => void | Promise<void>;
  /** Git fetch depth, bounded by the source-reading policy. */
  historyDepth?: number;
  /** Runner-owned persistent mirrors; standalone checkouts have no cache. */
  cacheRoot?: string;
  /** Hash every committed regular file into `digests`. */
  digests?: boolean;
}

/** One committed regular file and the SHA-256 digest of its content. */
export interface CheckoutFileDigest { path: string; sha256: string }

export interface RepositoryCheckout {
  root: string;
  commit: string;
  files: string[];
  changedPaths?: string[];
  changes?: { complete: boolean; changes: RepositoryChange[] };
  /** Every committed regular file whose path fits one listing line, sorted by path; present when the request asked for digests. */
  digests?: CheckoutFileDigest[];
  dispose: () => Promise<void>;
}

/** A path a `sha256sum` line cannot carry: a line break would split the line. */
const UNLISTABLE_PATH = /[\n\r]/;

/**
 * The SHA-256 digest of each named file under `root`, streamed, sorted by path.
 * A path with a line break is left out; a file without a digest is one a map
 * run revisits rather than one it grounds.
 */
export async function hashCommittedFiles(root: string, paths: readonly string[], signal: AbortSignal): Promise<CheckoutFileDigest[]> {
  const digests: CheckoutFileDigest[] = [];
  for (const path of paths) {
    signal.throwIfAborted();
    if (UNLISTABLE_PATH.test(path)) continue;
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(join(root, path), { signal })) hash.update(chunk as Buffer);
    digests.push({ path, sha256: hash.digest('hex') });
  }
  return digests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** One bounded Git process group; cancellation stops its transport children too. */
async function git(
  executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const command = process.platform === 'linux' ? ['prlimit', `--fsize=${MAX_REPOSITORY_BYTES}`, '--', executable, ...args] : [executable, ...args];
    const child = spawn(command[0], command.slice(1), { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = Buffer.alloc(0);
    let failure: Error | undefined;
    const stop = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error;
      }
    };
    const abort = () => { failure = new Error('Repository checkout was cancelled.'); stop(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_GIT_OUTPUT_BYTES) {
        failure = new RepositoryCheckoutError('too_large', 'Repository checkout exceeded its Git output limit.');
        stop();
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-MAX_GIT_OUTPUT_BYTES);
    });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure);
      else if (code !== 0) {
        const summary = stderr.toString('utf8');
        const token = env.MYCO_GIT_TOKEN ?? '';
        const username = env.MYCO_GIT_USERNAME ?? '';
        const secrets = [token, username, ...(token && username ? [username + ':' + token] : [])];
        reject(new RepositoryCheckoutError(gitFailureCode(summary), `Repository Git operation failed (exit ${code ?? 'signal'}). Check the repository, branch, and read credential.`, summary, secrets));
      }
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/** Git's transport and filesystem errors become a closed preparation reason. */
function gitFailureCode(words: string): RepositoryFailureCode {
  if (/no space left|disk quota|file too large|read-only file system|unable to write|cannot create.*(?:directory|file)/i.test(words)) return 'disk';
  if (/authentication failed|access denied|permission denied|returned error: (?:401|403)|could not read (?:Username|Password)/i.test(words)) return 'access_refused';
  if (/repository .*not found|repository not found|returned error: 404|does not appear to be a git repository/i.test(words)) return 'not_found';
  if (/couldn.t find remote ref|not our ref|not a valid (?:object|commit)|bad object|unknown revision|needed a single revision/i.test(words)) return 'revision_missing';
  return 'other';
}

/** Prepare committed files in an isolated workspace; no repository hooks or filters execute. */
export async function prepareRepositoryCheckout(request: RepositoryCheckoutRequest): Promise<RepositoryCheckout> {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(CHECKOUT_TIMEOUT_MS)]);
  const url = repositoryUrl(request.url);
  repositoryBranch(request.branch);
  if (request.commit !== undefined && !SHA_PATTERN.test(request.commit)) throw new RepositoryCheckoutError('commit_mismatch', 'Invalid repository commit.');
  if (request.compareCommit !== undefined && !SHA_PATTERN.test(request.compareCommit)) throw new RepositoryCheckoutError('commit_mismatch', 'Invalid comparison commit.');
  const depth = request.historyDepth ?? 1;
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_REPOSITORY_HISTORY_DEPTH) throw new Error('Invalid repository history depth.');
  let directory: string | undefined;
  let root = request.destination ?? '';
  let ownsRoot = false;
  const dispose = async () => {
    try {
      if (ownsRoot && request.destination !== undefined) {
        if (request.removeDestination !== undefined) await request.removeDestination();
        else await rm(root, { recursive: true, force: true });
      }
    } finally { if (directory !== undefined) await rm(directory, { recursive: true, force: true }); }
  };
  try {
    directory = await mkdtemp(join(tmpdir(), 'myco-repository-'));
    root = request.destination ?? join(directory, 'checkout');
    await mkdir(root, { mode: 0o700 });
    ownsRoot = true;
    const askpass = join(directory, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$MYCO_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$MYCO_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory, TMPDIR: directory,
      CODEX_HOME: directory, CLAUDE_CONFIG_DIR: directory,
      XDG_CONFIG_HOME: directory, MYCO_HOME: directory,
      LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
      GIT_LFS_SKIP_SMUDGE: '1',
      ...(request.credential === undefined ? {} : {
        MYCO_GIT_USERNAME: request.credential.username,
        MYCO_GIT_TOKEN: request.credential.token,
      }),
    };
    const runAt = (cwd: string, args: string[]) => git(request.gitPath ?? 'git', [
      '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
      '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      ...args,
    ], cwd, env, signal);
    const run = (...args: string[]) => runAt(root,args);
    const prepare = async (mirror?: RepositoryMirror): Promise<RepositoryCheckout> => {
      await run('check-ref-format', `refs/heads/${request.branch}`);
      let resolved: string;
      if (mirror === undefined) {
        await run('init', '--quiet', '--template=');
        await run('remote', 'add', 'origin', url);
        await run('fetch', '--quiet', `--depth=${depth}`, '--no-tags', 'origin', request.commit ?? `refs/heads/${request.branch}`);
        resolved=(await run('rev-parse','--verify','FETCH_HEAD^{commit}')).trim();
      } else {
        resolved=await mirror.fetch(request.commit);
        await run('-c','protocol.file.allow=always','clone','--quiet','--no-local',`--depth=${depth}`,'--single-branch','--branch',request.branch,'--no-checkout','--no-hardlinks','--template=',mirror.root,'.');
        await run('remote','set-url','origin',url);
        await run('-c','protocol.file.allow=always','fetch','--quiet',`--depth=${depth}`,'--no-tags',mirror.root,resolved);
      }
      if (!SHA_PATTERN.test(resolved)) throw new RepositoryCheckoutError('commit_mismatch', 'Repository returned an invalid commit.');
      const pinned = await request.pin(resolved);
      if (!SHA_PATTERN.test(pinned)) throw new RepositoryCheckoutError('commit_mismatch', 'Repository pin returned an invalid commit.');
      const fetchCommit = async (commit: string, history: number) => {
        if (mirror === undefined) await run('fetch','--quiet',`--depth=${history}`,'--no-tags','origin',commit);
        else {
          await mirror.fetch(commit);
          await run('-c','protocol.file.allow=always','fetch','--quiet',`--depth=${history}`,'--no-tags',mirror.root,commit);
        }
      };
      if (pinned !== resolved) await fetchCommit(pinned,depth);
      let changes: RepositoryCheckout['changes'];
      if (request.compareCommit !== undefined) {
        changes = { complete: false, changes: [] };
        try {
          if (request.compareCommit !== pinned) await fetchCommit(request.compareCommit, 1);
          // Renames expose both their deleted source and added destination.
          const output = await run('diff-tree', '--no-commit-id', '--no-renames', '--name-status', '-r', '-z', request.compareCommit, pinned);
          const fields = output.split('\0');
          if (fields.at(-1) === '') fields.pop();
          const evidence: RepositoryChange[] = [];
          for (let index = 0; index < fields.length; index += 2) {
            evidence.push({ status: fields[index] as RepositoryChange['status'], path: fields[index + 1]! });
          }
          const candidate = { commit: request.compareCommit, revision: 'comparison', repositoryRevision: 'comparison', settingsRevision: 0, complete: true, changes: evidence };
          if (evidence.length <= MAX_REPOSITORY_CHANGED_PATHS && Buffer.byteLength(JSON.stringify(candidate)) <= MAX_REPOSITORY_COMPARISON_BYTES
            && parseRepositoryChanges(candidate) !== null) changes = { complete: true, changes: evidence };
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RepositoryCheckoutError)) throw error;
        }
      }
      const files = (await run('ls-tree', '-r', '-l', '-z', pinned)).split('\0').filter(Boolean).map((entry) => {
        const tab = entry.indexOf('\t');
        const [mode, , , size] = entry.slice(0, tab).trim().split(/\s+/);
        if (mode === '160000') throw new RepositoryCheckoutError('submodules', 'Repository contains submodules; submodule source is not supported yet.');
        return { mode, size: Number(size), path: entry.slice(tab + 1) };
      });
      const bytes = files.reduce((total, file) => total + file.size, 0);
      if (!Number.isSafeInteger(bytes) || bytes > MAX_REPOSITORY_BYTES) throw new RepositoryCheckoutError('too_large', 'Repository committed files exceed the 256 MiB checkout limit.');
      await run('checkout', '--quiet', '--detach', pinned);
      const actual = (await run('rev-parse', 'HEAD')).trim();
      if (actual !== pinned) throw new RepositoryCheckoutError('commit_mismatch', 'Repository checkout does not match its pinned commit.');
      const regular = files.filter((entry) => entry.mode === '100644' || entry.mode === '100755').map((entry) => entry.path);
      for (const path of regular) {
        signal.throwIfAborted();
        const file = await open(join(root, path), 'r');
        try {
          const bytes = Buffer.alloc(LFS_POINTER_PREFIX.length);
          await file.read(bytes, 0, bytes.length, 0);
          if (bytes.toString('utf8') === LFS_POINTER_PREFIX) throw new RepositoryCheckoutError('lfs', 'Repository contains Git LFS pointers; LFS source is not supported yet.');
        } finally { await file.close(); }
      }
      const digests = request.digests === true ? await hashCommittedFiles(root, regular, signal) : undefined;
      await rm(askpass);
      delete env.MYCO_GIT_USERNAME;
      delete env.MYCO_GIT_TOKEN;
      return { root, commit: pinned, files: files.map(file => file.path), changedPaths: changes?.complete ? changes.changes.map(change => change.path) : undefined, changes, ...(digests === undefined ? {} : { digests }), dispose };
    };
    return await (request.cacheRoot === undefined ? prepare() : withRepositoryMirror(request.cacheRoot,{url,branch:request.branch},signal,runAt,prepare));
  } catch (error) {
    await dispose();
    if (error instanceof RepositoryCheckoutError) throw error;
    if (signal.aborted && !request.signal.aborted) {
      throw new RepositoryCheckoutError('timed_out', 'Repository preparation timed out.', `Preparation exceeded ${CHECKOUT_TIMEOUT_MS / 1000} seconds.`);
    }
    if (request.signal.aborted || typeof (error as NodeJS.ErrnoException)?.code !== 'string') throw error;
    const words = error instanceof Error ? error.message : String(error);
    const disk = ['ENOSPC', 'EDQUOT', 'EROFS', 'EFBIG'].includes((error as NodeJS.ErrnoException)?.code ?? '');
    throw new RepositoryCheckoutError(disk ? 'disk' : gitFailureCode(words), 'Repository preparation failed.', words,
      request.credential === undefined ? [] : [request.credential.token, request.credential.username, `${request.credential.username}:${request.credential.token}`]);
  }
}
