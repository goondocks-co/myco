import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { createProjectId, projectScope } from '@myco/grove/ids.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { gatherSources, type OkfSourceScope } from '@myco/okf/synthesis/sources.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db.js';

const AGENT_ID = 'claude-code';
const MACHINE_ID = 'test-machine-okf';
let projectRoot: string;
let projectId: string;

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

beforeEach(() => {
  cleanTestDb();
  registerAgent({ id: AGENT_ID, name: 'Myco Agent', created_at: 1_783_000_000 });
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okf-sources-')));
  projectId = createProjectId();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function config(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3, okf: { enabled: true } });
}

function scope(over: Partial<OkfSourceScope> = {}): OkfSourceScope {
  return {
    projectRoot,
    scope: projectScope(projectId as ReturnType<typeof createProjectId>),
    projectId,
    machineId: MACHINE_ID,
    config: config(),
    outputRoot: path.join(projectRoot, 'okf'),
    ...over,
  };
}

function writeFile(rel: string, content: string): void {
  const abs = path.join(projectRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: projectRoot, stdio: 'ignore' });
}

function gitOutput(args: string[]): string {
  return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8' }).trim();
}

function initGitRepo(): void {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
}

function commitAll(message: string): void {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
}

describe('gatherSources', () => {
  it('gathers the repo tree, git context since sinceRef, and vault summaries', () => {
    writeFile('src/index.ts', 'export const x = 1;\n');
    writeFile('README.md', '# root\n');
    writeFile('node_modules/dep/index.js', 'module.exports = {};\n');
    writeFile('okf/index.md', 'stale published bundle\n');
    initGitRepo();
    commitAll('initial');
    const headSha = gitOutput(['rev-parse', 'HEAD']);

    insertSpore({
      id: 'gotcha-1',
      project_id: projectId,
      agent_id: AGENT_ID,
      observation_type: 'gotcha',
      content: 'Some gotcha content long enough to exercise title truncation logic in the summary ref.',
      importance: 5,
      created_at: 1_783_000_000,
      machine_id: MACHINE_ID,
    });
    insertSpore({
      id: 'decision-1',
      project_id: projectId,
      agent_id: AGENT_ID,
      observation_type: 'decision',
      content: 'We decided to emit real OKF v0.1 documents.',
      importance: 5,
      created_at: 1_783_000_100,
      machine_id: MACHINE_ID,
    });

    seedCanopyEntry(getDatabase(), {
      project_id: projectId,
      path: 'src/index.ts',
      llm_description: 'Entry point.',
      language: 'typescript',
    });
    writeCanopyMap({
      project_id: projectId,
      machine_id: MACHINE_ID,
      content: '# Canopy Map\n',
      inputs_hash: 'hash1',
      token_estimate: 10,
    });

    const result = gatherSources(scope({ sinceRef: headSha }));

    // repoTree is a bounded top-level ORIENTATION, not a full file list:
    // top-level dirs with recursive counts + repo-root files.
    const dirNames = result.repoTree.topLevelDirs.map((d) => d.path);
    expect(dirNames).toContain('src');
    expect(result.repoTree.topLevelDirs.find((d) => d.path === 'src')?.fileCount).toBeGreaterThanOrEqual(1);
    expect(result.repoTree.rootFiles).toContain('README.md');
    expect(result.repoTree.totalFiles).toBeGreaterThanOrEqual(2);
    // .git / node_modules / the published bundle dir are excluded from both.
    const everyPath = [...dirNames, ...result.repoTree.rootFiles];
    expect(everyPath.some((p) => p === 'node_modules' || p.startsWith('node_modules'))).toBe(false);
    expect(everyPath.some((p) => p === '.git' || p.startsWith('.git'))).toBe(false);
    expect(everyPath.some((p) => p === 'okf' || p.startsWith('okf'))).toBe(false);

    expect(result.gitContext.headSha).toBe(headSha);
    expect(result.gitContext.sinceRef).toBe(headSha);
    expect(result.gitContext.changedPaths).toEqual([]);

    expect(result.vault.canopyMap).toBe('# Canopy Map\n');
    expect(result.vault.canopyEntries).toHaveLength(1);
    expect(result.vault.canopyEntries[0]).toMatchObject({ id: 'src/index.ts', title: 'Entry point.' });

    expect(result.vault.decisions).toHaveLength(1);
    expect(result.vault.decisions[0].id).toBe('decision-1');
    expect(result.vault.spores.some((s) => s.id === 'decision-1')).toBe(false);
    expect(result.vault.spores.some((s) => s.id === 'gotcha-1')).toBe(true);
  });

  it('reports changedPaths since sinceRef across a later commit', () => {
    writeFile('a.md', 'one\n');
    initGitRepo();
    commitAll('first');
    const firstSha = gitOutput(['rev-parse', 'HEAD']);

    writeFile('b.md', 'two\n');
    commitAll('second');

    const result = gatherSources(scope({ sinceRef: firstSha }));
    expect(result.gitContext.changedPaths).toEqual(['b.md']);
    expect(result.gitContext.headSha).not.toBe(firstSha);
  });

  it('a project with no sinceRef gets a full-scan signal even inside a git repo', () => {
    writeFile('a.md', 'one\n');
    initGitRepo();
    commitAll('first');

    const result = gatherSources(scope());
    expect(result.gitContext.headSha).not.toBeNull();
    expect(result.gitContext.changedPaths).toBeNull();
    expect(result.gitContext.sinceRef).toBeNull();
  });

  it('a non-git project returns changedPaths: null without throwing', () => {
    writeFile('README.md', '# hi\n');

    expect(() => gatherSources(scope({ sinceRef: 'deadbeef' }))).not.toThrow();
    const result = gatherSources(scope({ sinceRef: 'deadbeef' }));
    expect(result.gitContext.headSha).toBeNull();
    expect(result.gitContext.changedPaths).toBeNull();
    expect(result.repoTree.rootFiles).toContain('README.md');
  });

  it('an unreachable sinceRef (e.g. a shallow clone) falls back to full-scan without throwing', () => {
    writeFile('a.md', 'one\n');
    initGitRepo();
    commitAll('first');

    expect(() => gatherSources(scope({ sinceRef: 'not-a-real-ref' }))).not.toThrow();
    const result = gatherSources(scope({ sinceRef: 'not-a-real-ref' }));
    expect(result.gitContext.headSha).not.toBeNull();
    expect(result.gitContext.changedPaths).toBeNull();
  });
});
