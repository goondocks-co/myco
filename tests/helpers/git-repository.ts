import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_READ_CREDENTIAL = { username: 'reader', token: 'fixture-only-repository-read-token' };

/**
 * Two real commits served through Git's HTTPS upload-pack protocol. `github` names the GitHub address the fixture
 * answers for, so a checkout of the address a Deployment names reaches this server; `accepts` decides a credential.
 */
export async function gitRepositoryFixture(access: 'private' | 'public' = 'private', options: { github?: string; accepts?: (username: string, token: string) => boolean } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'myco-git-fixture-'));
  const repo = join(home, 'source');
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Repository fixture');
  await writeFile(join(repo, 'AGENTS.md'), 'First committed rules.');
  git('add', '.'); git('commit', '--quiet', '-m', 'first'); const first = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'AGENTS.md'), 'Second committed rules.');
  git('commit', '--quiet', '-am', 'second'); const second = git('rev-parse', 'HEAD');
  git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const key = join(home, 'key.pem');
  const cert = join(home, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const gitPath = join(home, 'git-fixture');
  await writeFile(gitPath, `#!/bin/sh\nGIT_SSL_CAINFO='${cert}' exec git "$@"\n`, { mode: 0o700 });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    tls: { key: await readFile(key), cert: await readFile(cert) },
    async fetch(request) {
      const [username = '', token = ''] = Buffer.from((request.headers.get('authorization') ?? '').replace(/^Basic /, ''), 'base64').toString().split(':');
      const accepted = options.accepts?.(username, token) ?? (username === GIT_READ_CREDENTIAL.username && token === GIT_READ_CREDENTIAL.token);
      if (access === 'private' && !accepted) {
        return new Response('Read credential required', { status: 401, headers: { 'www-authenticate': 'Basic realm="repository"' } });
      }
      const endpoint = new URL(request.url);
      const advertise = endpoint.pathname === '/repo.git/info/refs';
      if (!advertise && endpoint.pathname !== '/repo.git/git-upload-pack') return new Response('Not found', { status: 404 });
      const child = Bun.spawn(['git', 'upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), repo], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
      if (!advertise) child.stdin.write(await request.arrayBuffer());
      child.stdin.end();
      const [body, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
      if (code !== 0) return new Response('Git failed', { status: 500 });
      return new Response(advertise ? Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), Buffer.from(body)]) : body, {
        headers: { 'content-type': `application/x-git-upload-pack-${advertise ? 'advertisement' : 'result'}` },
      });
    },
  });
  const url = `https://localhost:${server.port}/repo.git`;
  if (options.github !== undefined) await writeFile(gitPath, `#!/bin/sh\nGIT_SSL_CAINFO='${cert}' exec git -c 'url.${url}.insteadOf=${options.github}' "$@"\n`, { mode: 0o700 });
  return { home, repo, git, gitPath, first, second, url,
    dispose: async () => { server.stop(true); await rm(home, { recursive: true, force: true }); },
  };
}

/** GitHub's token revocation, recording what a runner ended. https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token */
export function tokenRevocations() {
  const revoked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.redirect !== 'manual') throw new TypeError('GitHub requests leave redirects to the caller');
    const request = new Request(input, init);
    if (request.method !== 'DELETE' || request.url !== 'https://api.github.com/installation/token') throw new Error(`unexpected GitHub request ${request.method} ${request.url}`);
    revoked.push(request.headers.get('authorization')!.replace(/^Bearer /, ''));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { fetchImpl, revoked };
}
