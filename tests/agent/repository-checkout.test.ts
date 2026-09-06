import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRepositoryCheckout, repositoryUrl } from '../../packages/myco/src/agent/runtime/repository-checkout.js';

let home: string;
let repo: string;
let gitPath: string;
let first: string;
let second: string;
let server: ReturnType<typeof Bun.serve>;
let url: string;
const token = 'fixture-only-repository-read-token';
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'myco-git-fixture-'));
  repo = join(home, 'source');
  await mkdir(repo);
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Repository fixture');
  await writeFile(join(repo, 'AGENTS.md'), 'First committed rules.');
  git('add', '.'); git('commit', '--quiet', '-m', 'first'); first = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'AGENTS.md'), 'Second committed rules.');
  git('commit', '--quiet', '-am', 'second'); second = git('rev-parse', 'HEAD');
  git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  const key = join(home, 'key.pem');
  const cert = join(home, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  gitPath = join(home, 'git-fixture');
  await writeFile(gitPath, `#!/bin/sh\nGIT_SSL_CAINFO='${cert}' exec git "$@"\n`, { mode: 0o700 });
  server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    tls: { key: await readFile(key), cert: await readFile(cert) },
    async fetch(request) {
      if (request.headers.get('authorization') !== `Basic ${Buffer.from(`reader:${token}`).toString('base64')}`) {
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
  url = `https://localhost:${server.port}/repo.git`;
}, 20_000);

afterAll(async () => { server?.stop(true); await rm(home, { recursive: true, force: true }); });

const request = () => ({ url, branch: 'main', credential: { username: 'reader', token }, gitPath, signal: AbortSignal.timeout(15_000) });

describe('committed repository checkout', () => {
  it('checks out the commit pinned for the run even when the branch has advanced', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), pin: async (resolved) => { expect(resolved).toBe(second); return first; } });
    try {
      expect(checkout.commit).toBe(first);
      expect(await readFile(join(checkout.root, 'AGENTS.md'), 'utf8')).toBe('First committed rules.');
      const config = await readFile(join(checkout.root, '.git/config'), 'utf8');
      expect(config).not.toContain(token);
      expect(config).not.toContain('reader');
    } finally { await checkout.dispose(); }
    await expect(access(checkout.root)).rejects.toThrow();
  });

  it('uses a fresh workspace and committed content for each run', async () => {
    const a = await prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit });
    const b = await prepareRepositoryCheckout({ ...request(), commit: first, pin: async (commit) => commit });
    try {
      expect(a.root).not.toBe(b.root);
      expect(a.commit).toBe(second);
      expect(b.commit).toBe(first);
      await writeFile(join(a.root, 'AGENTS.md'), 'task-local change');
      expect(await readFile(join(b.root, 'AGENTS.md'), 'utf8')).toBe('First committed rules.');
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
  });

  it('refuses invalid credentials without exposing them', async () => {
    let message = '';
    try {
      await prepareRepositoryCheckout({ ...request(), credential: { username: 'reader', token: 'revoked-fixture-token' }, pin: async (commit) => commit });
    } catch (error) { message = (error as Error).message; }
    expect(message).toContain('Git operation failed');
    expect(message).not.toContain('revoked-fixture-token');
  });

  it('refuses cancellation and a failed pin before exposing a workspace', async () => {
    await expect(prepareRepositoryCheckout({ ...request(), signal: AbortSignal.abort(), pin: async (commit) => commit })).rejects.toThrow();
    await expect(prepareRepositoryCheckout({ ...request(), pin: async () => { throw new Error('run is no longer held'); } })).rejects.toThrow('run is no longer held');
  });

  it('accepts only explicit HTTPS repository URLs without embedded credentials', () => {
    for (const url of ['file:///etc', 'http://example.test/repo', 'https://token@example.test/repo', 'https://example.test/repo?token=secret', 'https://example.test/']) {
      expect(() => repositoryUrl(url)).toThrow();
    }
    expect(repositoryUrl('https://example.test/team/repo.git')).toBe('https://example.test/team/repo.git');
  });
});
