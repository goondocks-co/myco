import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCommittedFiles, prepareRepositoryCheckout, repositoryUrl } from '@myco/runner/repository-checkout.js';
import { prepareWorkerCheckout } from '@myco/runner/repository.js';
import { writeRunDir, discardRunDir } from '@myco/runner/mcp-config.js';
import { beginRunProcess, retryPendingRunDirectoryDiscards } from '@myco/runner/run-directory.js';
import { RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';

import { gitRepositoryFixture, GIT_READ_CREDENTIAL } from '../helpers/git-repository.js';

let fixture: Awaited<ReturnType<typeof gitRepositoryFixture>>;
let home: string;
let repo: string;
let gitPath: string;
let first: string;
let second: string;
let url: string;
const token = GIT_READ_CREDENTIAL.token;
const git = (...args: string[]) => fixture.git(...args);

beforeAll(async () => {
  fixture = await gitRepositoryFixture();
  ({ home, repo, gitPath, first, second, url } = fixture);
}, 20_000);

afterAll(async () => { await fixture?.dispose(); });

const request = () => ({ url, branch: 'main', credential: { username: 'reader', token }, gitPath, signal: AbortSignal.timeout(15_000) });

describe('committed repository checkout', () => {
  it('supplies bounded history and removes its owned destination without removing pre-existing paths', async () => {
    const destination = join(home, 'run-source');
    const checkout = await prepareRepositoryCheckout({ ...request(), destination, historyDepth: 200, digests: true, pin: async (commit) => commit });
    try {
      expect(checkout.root).toBe(destination);
      expect(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: checkout.root, encoding: 'utf8' }).trim()).toBe('2');
      await expect(prepareRepositoryCheckout({ ...request(), destination, pin: async (commit) => commit })).rejects.toThrow();
      expect(await readFile(join(destination, 'AGENTS.md'), 'utf8')).toBe('Second committed rules.');
      expect(checkout.digests).toEqual([{ path: 'AGENTS.md', sha256: createHash('sha256').update('Second committed rules.').digest('hex') }]);
    } finally { await checkout.dispose(); }
    await expect(access(destination)).rejects.toThrow();
  });

  it('checks out the commit pinned for the run even when the branch has advanced', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), pin: async (resolved) => { expect(resolved).toBe(second); return first; } });
    try {
      expect(checkout.commit).toBe(first);
      expect(checkout).not.toHaveProperty('digests');
      expect(await readFile(join(checkout.root, 'AGENTS.md'), 'utf8')).toBe('First committed rules.');
      const config = await readFile(join(checkout.root, '.git/config'), 'utf8');
      expect(config).not.toContain(token);
      expect(config).not.toContain('reader');
    } finally { await checkout.dispose(); }
    await expect(access(checkout.root)).rejects.toThrow();
  });

  it('configures no program in the checkout\'s repository: only its format and its remote', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), pin: async (commit) => commit });
    try {
      const keys = execFileSync('git', ['config', '--file', join(checkout.root, '.git/config'), '--name-only', '--list'], { encoding: 'utf8' }).split('\n').filter(Boolean);
      const format = ['core.repositoryformatversion', 'core.filemode', 'core.bare', 'core.logallrefupdates', 'core.ignorecase', 'core.precomposeunicode', 'core.symlinks'];
      expect(keys.filter((key) => !format.includes(key.toLowerCase()))).toEqual(['remote.origin.url', 'remote.origin.fetch']);
      const beside = ['info/attributes', 'config.worktree', 'commondir'].filter((path) => existsSync(join(checkout.root, '.git', path)));
      expect(beside).toEqual([]);
    } finally { await checkout.dispose(); }
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

  it('compares the pinned tree with the prior map commit for changed-file discovery', async () => {
    const checkout = await prepareRepositoryCheckout({ ...request(), compareCommit: first, pin: async (commit) => commit });
    try {
      expect(checkout.commit).toBe(second);
      expect(checkout.changedPaths).toEqual(['AGENTS.md']);
    } finally { await checkout.dispose(); }
  });

  it('streams a digest of each named file, sorted, and leaves out a path a listing line cannot carry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'myco-digests-'));
    try {
      await writeFile(join(root, 'b.ts'), 'b');
      await writeFile(join(root, 'a.ts'), 'a');
      await writeFile(join(root, 'split\nname.ts'), 'x');
      await writeFile(join(root, 'carriage\rname.ts'), 'y');
      const sha = (text: string) => createHash('sha256').update(text).digest('hex');
      expect(await hashCommittedFiles(root, ['b.ts', 'split\nname.ts', 'a.ts', 'carriage\rname.ts'], AbortSignal.timeout(5_000)))
        .toEqual([{ path: 'a.ts', sha256: sha('a') }, { path: 'b.ts', sha256: sha('b') }]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('writes the digest listing beside a worker checkout only when the run asks for one', async () => {
    const answer = async (input: Record<string, unknown>) => input.commit === undefined
      ? { repository: { url, branch: 'main', credential: { username: 'reader', token } } }
      : { pin: { url, branch: 'main', commit: input.commit } };
    const spec = { url, branch: 'main', historyDepth: 1 };
    for (const digests of [true, false]) {
      const allocation = await mkdtemp(join(tmpdir(), 'myco-worker-checkout-'));
      const { scratchDir: scratch } = writeRunDir(allocation, 'run_checkout', { serverUrl: 'https://server.example.test', runToken: 'synthetic-run-token', projectId: 'project_fixture' });
      try {
        const checkout = await prepareWorkerCheckout(spec, scratch, AbortSignal.timeout(15_000), answer, { gitPath, digests });
        try {
          const listing = await readFile(join(scratch, RUN_REPOSITORY_DIGESTS_FILE), 'utf8').catch(() => null);
          expect({ digests, listing }).toEqual({ digests, listing: digests ? `${createHash('sha256').update('Second committed rules.').digest('hex')}  AGENTS.md\n` : null });
        } finally { await checkout.dispose(); }
      } finally { discardRunDir(scratch); await rm(allocation, { recursive: true, force: true }); }
    }
  });

  it('preserves worker checkout files until their registered harness owner exits', async () => {
    const allocation = await mkdtemp(join(tmpdir(), 'myco-worker-checkout-'));
    const { scratchDir } = writeRunDir(allocation, 'run_owned_checkout', { serverUrl: 'https://server.example.test', runToken: 'synthetic-run-token', projectId: 'project_fixture' });
    const answer = async (input: Record<string, unknown>) => input.commit === undefined
      ? { repository: { url, branch: 'main', credential: { username: 'reader', token } } }
      : { pin: { url, branch: 'main', commit: input.commit } };
    const checkout = await prepareWorkerCheckout({ url, branch: 'main', historyDepth: 1 }, scratchDir, AbortSignal.timeout(15_000), answer, { gitPath });
    const launch = beginRunProcess(scratchDir)!;
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: checkout.root, detached: process.platform !== 'win32', stdio: 'ignore', env: process.env });
    const exited = new Promise<void>((resolve) => owner.once('close', () => resolve()));
    launch.started(owner.pid!);
    try {
      await expect(checkout.dispose()).rejects.toThrow('harness owner');
      expect(await readFile(join(checkout.root, 'AGENTS.md'), 'utf8')).toBe('Second committed rules.');
    } finally {
      process.kill(process.platform === 'win32' ? owner.pid! : -owner.pid!, 'SIGKILL');
      await exited;
      retryPendingRunDirectoryDiscards();
      discardRunDir(scratchDir);
      await rm(allocation, { recursive: true, force: true });
    }
    expect(existsSync(scratchDir)).toBe(false);
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

describe('a checkout a task is given', () => {
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
