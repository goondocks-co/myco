import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_GIT_OUTPUT_BYTES = 1_000_000;
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface RepositoryCheckoutRequest {
  url: string;
  branch: string;
  credential?: { username: string; token: string };
  commit?: string;
  signal: AbortSignal;
  /** Persist the resolved commit before any file is exposed to a task. */
  pin: (commit: string) => Promise<string>;
  /** Executable override for runtime packaging and integration fixtures. */
  gitPath?: string;
}

export interface RepositoryCheckout {
  root: string;
  commit: string;
  dispose: () => Promise<void>;
}

/** HTTPS source with credentials supplied independently of the remote URL. */
export function repositoryUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/') {
    throw new Error('Repository URL must be HTTPS, with a repository path and no credentials, query, or fragment.');
  }
  return url.href;
}

/** One bounded Git process group; cancellation stops its transport children too. */
async function git(
  executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
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
        failure = new Error('Repository checkout exceeded its Git output limit.');
        stop();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure);
      else if (code !== 0) reject(new Error(`Repository Git operation failed (exit ${code ?? 'signal'}). Check the repository, branch, and read credential.`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

/** Prepare committed files in an isolated workspace; no repository hooks or filters execute. */
export async function prepareRepositoryCheckout(request: RepositoryCheckoutRequest): Promise<RepositoryCheckout> {
  const url = repositoryUrl(request.url);
  if (request.commit !== undefined && !SHA_PATTERN.test(request.commit)) throw new Error('Invalid repository commit.');
  const directory = await mkdtemp(join(tmpdir(), 'myco-repository-'));
  const root = join(directory, 'checkout');
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    await mkdir(root);
    const askpass = join(directory, 'askpass.sh');
    await writeFile(askpass, '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "$MYCO_GIT_USERNAME" ;;\n  *Password*) printf "%s\\n" "$MYCO_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: directory,
      LANG: 'C', LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
      GIT_LFS_SKIP_SMUDGE: '1',
      ...(request.credential === undefined ? {} : {
        MYCO_GIT_USERNAME: request.credential.username,
        MYCO_GIT_TOKEN: request.credential.token,
      }),
    };
    const run = (...args: string[]) => git(request.gitPath ?? 'git', [
      '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null',
      '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      ...args,
    ], root, env, request.signal);
    await run('check-ref-format', `refs/heads/${request.branch}`);
    await run('init', '--quiet', '--template=');
    await run('remote', 'add', 'origin', url);
    await run('fetch', '--quiet', '--depth=1', '--no-tags', 'origin', request.commit ?? `refs/heads/${request.branch}`);
    const resolved = await run('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    if (!SHA_PATTERN.test(resolved)) throw new Error('Repository returned an invalid commit.');
    const pinned = await request.pin(resolved);
    if (!SHA_PATTERN.test(pinned)) throw new Error('Repository pin returned an invalid commit.');
    if (pinned !== resolved) await run('fetch', '--quiet', '--depth=1', '--no-tags', 'origin', pinned);
    await run('checkout', '--quiet', '--detach', pinned);
    const actual = await run('rev-parse', 'HEAD');
    if (actual !== pinned) throw new Error('Repository checkout does not match its pinned commit.');
    await rm(askpass);
    delete env.MYCO_GIT_USERNAME;
    delete env.MYCO_GIT_TOKEN;
    return { root, commit: pinned, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
