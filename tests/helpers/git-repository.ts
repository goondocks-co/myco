import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_READ_CREDENTIAL = { username: 'reader', token: 'fixture-only-repository-read-token' };

/** Two real commits served through Git's HTTPS upload-pack protocol. */
export async function gitRepositoryFixture(access: 'private' | 'public' = 'private') {
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
      if (access === 'private' && request.headers.get('authorization') !== `Basic ${Buffer.from(`${GIT_READ_CREDENTIAL.username}:${GIT_READ_CREDENTIAL.token}`).toString('base64')}`) {
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
  return { home, repo, git, gitPath, first, second, url: `https://localhost:${server.port}/repo.git`,
    dispose: async () => { server.stop(true); await rm(home, { recursive: true, force: true }); },
  };
}
