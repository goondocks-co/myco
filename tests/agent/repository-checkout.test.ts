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

describe('code task runner', () => {
  it('prepares through held-run HTTP, exposes committed files and removes the workspace', async () => {
    const { sqliteEnv } = await import('../myco-server/helpers/fixtures.js');
    const { projectRepositories } = await import('@myco-server-worker/core/repositories.js');
    const { deploymentSecretStore } = await import('@myco-server-worker/core/secrets.js');
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    const { ensureMember } = await import('@myco-server-worker/auth/enrollment.js');
    const { recordDispatch } = await import('@myco-server-worker/core/runs.js');
    const { ServerClient } = await import('@myco/member/transport.js');
    const { runServerTask } = await import('@myco/agent/runtime/server-runner.js');
    const worker = (await import('@myco-server-worker/index.js')).default;
    const fixture = sqliteEnv();
    fixture.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
    const now = Date.now();
    await ensureMember(fixture.db, 'mem_harness', now, 'harness');
    const minted = await issueMemberToken(fixture.db, { memberId: 'mem_harness', machineId: 'machine_1' }, now);
    fixture.sqlite.query("INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES ('proj_1','skills',1,1,'test')").run();
    await projectRepositories(fixture.db, deploymentSecretStore(fixture.db, fixture.serverEnv.wrappingKey)).save('proj_1', {
      url, branch: 'main', revision: null, credential: { username: 'reader', token },
    }, 'mem_machine_1', now);
    await recordDispatch(fixture.db, { projectId: 'proj_1' }, { id: 'code-run', agentId: 'user', task: 'skill-generate', provider: 'anthropic', model: null, runContext: '{}', dispatchedBy: minted.tokenId, startedAt: now });
    const client = new ServerClient({ serverUrl: 'https://s', token: minted.token, projectId: 'proj_1' }, (async (input, init) => {
      const request = new Request(input, init);
      request.headers.set('cf-connecting-ip', '1.2.3.4');
      return worker.fetch(request, fixture.env);
    }) as typeof fetch);
    let workspace = '';
    const result = await runServerTask({
      client, budget: { connectTimeoutMs: 1000, requestTimeoutMs: 5000 }, runId: 'code-run', taskName: 'skill-generate', admission: 'skills', repositoryGitPath: gitPath,
      harness: { execute: async (input) => {
        workspace = input.toolSurface.projectRoot!;
        expect(workspace).toBeTruthy();
        expect(input.prompt).toContain(second);
        expect(input.prompt).not.toContain(token);
        const read = input.toolSurface.tools!.find((tool) => tool.name === 'fs_read')!;
        const rules = await read.handler({ path: 'AGENTS.md' }, {});
        expect(JSON.parse(rules.content[0].text).content).toBe('Second committed rules.');
        await expect(read.handler({ path: '.git/config' }, {})).rejects.toThrow();
        return { finalText: 'inspected', turnsUsed: 1 };
      }, supports: () => false } as import('@myco/agent/harness/types.js').AgentHarness,
    });
    expect(result.status).toBe('completed');
    await expect(access(workspace)).rejects.toThrow();
    const stored = fixture.sqlite.query("SELECT run_context FROM agent_runs WHERE id='code-run'").get() as { run_context: string };
    expect(JSON.parse(stored.run_context).repository.commit).toBe(second);
    fixture.sqlite.close();
  });

  it('refuses unsupported LFS content before giving a task any files', async () => {
    await writeFile(join(repo, 'large.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n');
    git('add', 'large.bin'); git('commit', '--quiet', '-m', 'lfs pointer');
    try {
      await expect(prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit })).rejects.toThrow('Git LFS');
    } finally { git('reset', '--hard', second); }
  });

  it('refuses submodule source before giving a task any files', async () => {
    git('update-index', '--add', '--cacheinfo', `160000,${first},dependency`);
    git('commit', '--quiet', '-m', 'submodule');
    try {
      await expect(prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit })).rejects.toThrow('submodule');
    } finally { git('reset', '--hard', second); }
  });
});
