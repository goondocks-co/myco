import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONSUMERS, buildSteps, parseArgs, rowTestFiles, selectConsumers, summaryLine, workflowStepTests } from '../../scripts/check-pr-plan.mjs';
import { imageInputs } from '../../scripts/check-pr-image.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const windowsTests = workflowStepTests(REPO, 'windows-native', 'Windows smoke contracts');
/** A changed file somewhere under a directory; the table selects by directory, never by a file's name. */
const under = (directory: string) => `${directory}/a-changed-module.ts`;
const select = (changed: string[], tests: string[] = []) => selectConsumers({ changed, tests, windowsTests });
const names = (changed: string[], tests: string[] = []) => select(changed, tests).map((row) => row.name);
const scratch = <T>(fn: (dir: string) => T | Promise<T>, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-check-pr-plan-'))) =>
  Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (root: string, files: Record<string, string>) => Object.entries(files).forEach(([file, text]) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text);
});

describe('check:pr consumers', () => {
  test.each([
    [[`packages/myco-shared/release-channels.json`], [], ['installer and source install', 'self-hosted image inputs', 'dashboard screens']],
    [[under('packages/myco/src/cli'), under('packages/myco/src/hooks'), 'packages/myco/src/symbionts/manifests/a.yaml'], [], ['compiled sign-in', 'compiled hook startup']],
    [['Makefile', 'install.sh', 'install.ps1', 'packages/myco/scripts/a.mjs'], [], ['installer and source install', 'Darwin release recipe']],
    [['packages/myco-server/Dockerfile', 'docs/a.md'], [], ['self-hosted image inputs', 'docs site']],
    [[under('packages/myco/src/member'), 'packages/myco/skills/a/SKILL.md'], [], []],
    [[under('packages/myco/src/member')], ['tests/parity/parity.test.ts', 'tests/member/rbac-routing-smoke.test.ts'], ['compiled repository routing', 'parity smoke (self-hosted)']],
    [[under('packages/myco/src/utils')], [windowsTests[0]!], ['Windows contracts']],
  ])('changing %j, reaching %j, selects %j', (changed, tests, expected) => {
    expect(names(changed, tests)).toEqual(expected);
  });

  test('a selected row names what selected it, and a row that cannot run here says why', () => {
    expect(select(['packages/myco-server/Dockerfile', under('packages/myco/src/member')])[0]?.reasons).toEqual(['packages/myco-server/Dockerfile']);
    expect(select(['scripts/a.mjs']).map((row) => row.ciOnly)).toEqual(['it cross-compiles and signs a release distribution']);
  });

  test('every row stands in for a job the CI workflow has, and the installer row runs the installer tests', () => {
    const workflow = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
    const jobs = Object.entries(workflow.jobs as Record<string, { name?: string }>).flatMap(([id, job]) => [id, (job.name ?? '').split(' (')[0]]);
    for (const row of CONSUMERS) expect([row.name, jobs.some((job) => job !== '' && row.ci.startsWith(job))]).toEqual([row.name, true]);
    const installer = CONSUMERS.find((row) => row.name === 'installer and source install')!;
    expect(rowTestFiles(installer, ['tests/install/a.test.ts', 'tests/install/a-fixture.ts', 'tests/scripts/source-install.test.ts', 'tests/cli/a.test.ts']))
      .toEqual(['tests/install/a.test.ts', 'tests/scripts/source-install.test.ts']);
  });
});

test('check:pr expands npm run build through scripts and workspaces, in order, without the executable compile', () => scratch((root) => {
  write(root, {
    'package.json': JSON.stringify({ scripts: { build: 'npm run build -w @x/a && npm run build -w @x/b' } }),
    'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { build: 'bun build.mjs' } }),
    'packages/b/package.json': JSON.stringify({ name: '@x/b', scripts: { build: 'npm run ui && npm run codegen && npm run build:binary && npm run build:verify',
      ui: 'node check.mjs && cd ui && npx vite build', codegen: 'tsx gen-one.ts && node gen-two.mjs', 'build:binary': 'x', 'build:verify': 'y' } }),
  });
  expect(buildSteps(root).map(({ cwd, command }) => `${cwd}: ${command}`)).toEqual(['packages/a: bun build.mjs', 'packages/b: node check.mjs',
    'packages/b/ui: npx vite build', 'packages/b: tsx gen-one.ts', 'packages/b: node gen-two.mjs']);
  const codegen = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/myco/package.json'), 'utf8')).scripts.codegen.split('&&').map((part: string) => part.trim());
  expect(buildSteps(REPO).map((step) => step.command)).toEqual(expect.arrayContaining(codegen));
}));

test('check:pr reads --skip-importers and --jobs, refuses anything else, and names on the final line what did not run and why', () => {
  expect([parseArgs([], 16), parseArgs(['--skip-importers', '--jobs', '3'], 16), parseArgs(['--jobs=2'], 2)])
    .toEqual([{ skipImporters: false, jobs: 8 }, { skipImporters: true, jobs: 3 }, { skipImporters: false, jobs: 2 }]);
  expect(() => parseArgs(['--jobs', '0'], 16)).toThrow('--jobs takes a positive whole number');
  expect(() => parseArgs(['--fast'], 16)).toThrow('options are --skip-importers and --jobs <shards>');
  expect(summaryLine({ passed: 20, failed: 0, seconds: 300, base: 'fef832746abc', notRun: [] })).toBe('check:pr: 20 passed, 0 failed in 300 s (base fef832746)');
  expect(summaryLine({ passed: 1, failed: 1, seconds: 9, base: 'fef832746abc', notRun: [{ what: '144 importing test files', why: '--skip-importers' }] }))
    .toBe('check:pr: 1 passed, 1 failed in 9 s (base fef832746); not run here: 144 importing test files (--skip-importers)');
});

const run = (command: string, _args: string[], { cwd }: { cwd: string }) => new Promise<string>((resolve, reject) => {
  const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('close', (code) => code === 0 ? resolve(output) : reject(Object.assign(new Error(output), { output })));
});
const dockerfile = ['FROM oven/bun:1.4.0-slim AS build', 'WORKDIR /build', 'COPY server/src ./src', 'COPY shared/src ./shared/src',
  'RUN bun build src/main.ts --target=bun --outfile=/build/server.js', 'FROM oven/bun:1.4.0-slim AS runtime', 'COPY server/run.sh ./run.sh'].join('\n');
const outcome = (files: Record<string, string>) => scratch((dir) => {
  write(path.join(dir, 'context'), { Dockerfile: dockerfile, 'server/src/main.ts': "import { word } from '../shared/src/word.ts';\nconsole.log(word);\n", ...files });
  return imageInputs({ context: path.join(dir, 'context'), dockerfile: 'Dockerfile', scratch: path.join(dir, 'image'), run, mirrorModules: () => {} })
    .then(() => 'built', (error: Error) => error.message);
});

test('check:pr image inputs pass when every file the bundle resolves is copied, and names the stage and file when one is not', async () => {
  expect(await outcome({ 'shared/src/word.ts': "export const word = 'ok';\n", 'server/run.sh': '' })).toBe('built');
  const missing = await outcome({ 'shared/src/word.ts': "import data from '../data.json';\nexport const word = data.word;\n", 'shared/data.json': '{"word":"ok"}', 'server/run.sh': '' });
  expect(missing).toContain('build: RUN bun build src/main.ts');
  expect(missing).toContain('../data.json');
  expect(await outcome({ 'shared/src/word.ts': "export const word = 'ok';\n" })).toBe('runtime: COPY server/run.sh: no such file in the build context');
});

test('the runner plans only the files a selection file lists, in the full run\'s groups, and takes no targets beside it', () => scratch((dir) => {
  const chosen = ['tests/myco-shared/command-shape.test.ts', 'tests/scripts/test-shards.test.ts'];
  fs.writeFileSync(path.join(dir, 'selection.txt'), `${chosen.join('\n')}\n`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
  const runner = (args: string[]) => spawnSync('node', ['scripts/run-bun-tests.mjs', ...args], { cwd: REPO, encoding: 'utf8', env: { ...inherited, TMPDIR: dir,
    MYCO_TEST_SELECTION_FILE: path.join(dir, 'selection.txt'), MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_PLAN_FILE: path.join(dir, 'plan.json'), MYCO_RUNNER_REPORT_DIR: path.join(dir, 'reports') } });
  const planned = runner([]);
  expect(planned.status, planned.stdout + planned.stderr).toBe(0);
  const phases = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as Array<{ label: string; files: string[] }>;
  expect(phases.flatMap((phase) => phase.files).sort()).toEqual(chosen);
  expect(phases.find((phase) => phase.files.includes(chosen[0]!))?.label).toBe('node env shared tests-myco-shared');
  expect(runner([chosen[1]!]).stderr).toContain('MYCO_TEST_SELECTION_FILE selects the files; pass no test targets with it');
}), 60_000);
