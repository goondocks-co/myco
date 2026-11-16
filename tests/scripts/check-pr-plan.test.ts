import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CONSUMERS, buildSteps, parseArgs, planConsumers, retryAlone, rowTestFiles, settleLanes, summaryLine, windowsJobTests } from '../../scripts/check-pr-plan.mjs';
import { imageInputs } from '../../scripts/check-pr-image.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const windowsTests = windowsJobTests(REPO);
/** A changed file somewhere under a directory; the table selects by directory, never by a file's name. */
const under = (directory: string) => `${directory}/a-changed-module.ts`;
/** What runs here and what the final line names as not run, for a change on a machine with every tool but `missing`. */
const names = (changed: string[], tests: string[] = [], missing: string[] = []) => {
  const { rows, notRun } = planConsumers({ changed, tests, windowsTests, hasTool: (tool) => !missing.includes(tool) });
  return { runs: rows.map((row) => row.name), notRun: notRun.map(({ what, why }) => `${what.split(' [')[0]} (${why})`) };
};
const scratch = <T>(fn: (dir: string) => T | Promise<T>, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-check-pr-plan-'))) =>
  Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (root: string, files: Record<string, string>) => Object.entries(files).forEach(([file, text]) =>
  (fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }), fs.writeFileSync(path.join(root, file), text)));
const IMAGE_BUILD = 'self-hosted image build, boot and persistence (CI only: it builds and boots the image with Docker)';

test.each([
  [['packages/myco-shared/release-channels.json'], [], ['installer and source install', 'self-hosted image inputs (build inputs only)', 'dashboard screens'], [IMAGE_BUILD]],
  [[under('packages/myco/src/cli'), under('packages/myco/src/symbionts/manifests')], [], ['harness configuration', 'compiled sign-in', 'compiled hook startup on this machine'], ['hook startup on Linux (CI only: it runs on Linux)',
    'hook startup on Windows (CI only: it runs on Windows)', 'Windows ARM64 smoke (CI only: it runs on Windows ARM64)']],
  [[under('packages/myco-server/src/core')], [], ['self-hosted image inputs (build inputs only)', 'native Deployment lifecycle'], [IMAGE_BUILD]],
  [['docs/install.ps1', 'docs/a.md'], [], ['installer and source install', 'docs site'], ['installer under Windows PowerShell 5.1 (CI only: it runs on Windows PowerShell 5.1)']],
  [['README.md', 'packages/myco/skills/a/SKILL.md'], ['tests/parity/parity.test.ts', 'tests/member/rbac-routing-smoke.test.ts', windowsTests[0]!], ['compiled repository routing', 'parity smoke (self-hosted)'],
    ['Windows contracts (CI only: it runs on Windows)', "parity, full run and Cloudflare target (CI only: lanes never boot the Cloudflare target, and the full run is CI's)"]],
  [['scripts/smoke-container-persistence.mjs'], [], [], [IMAGE_BUILD, 'Darwin release recipe (CI only: it cross-compiles and signs a release distribution)']],
])('check:pr changing %j, reaching %j, runs %j and names %j as not run', (changed, tests, runs, notRun) => {
  expect(names(changed, tests)).toEqual({ runs, notRun });
});

test('a consumer row whose tests need a missing tool runs nothing and is named as not run, with the tool', () => {
  expect(names(['Makefile'], [], ['pwsh', 'shellcheck'])).toEqual({ runs: [], notRun: ['installer and source install (pwsh, shellcheck not installed)'] });
});

test('every consumer row stands in for a job the CI workflow has, and the installer row runs the installer tests', () => {
  const workflow = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  const jobs = Object.entries(workflow.jobs as Record<string, { name?: string }>).flatMap(([id, job]) => [id, (job.name ?? '').split(' (')[0]]);
  for (const row of CONSUMERS) expect([row.name, jobs.some((job) => job !== '' && row.ci.startsWith(job))]).toEqual([row.name, true]);
  expect(rowTestFiles(CONSUMERS[0]!, ['tests/install/a.test.ts', 'tests/install/a-fixture.ts', 'tests/scripts/source-install.test.ts', 'tests/cli/a.test.ts']))
    .toEqual(['tests/install/a.test.ts', 'tests/scripts/source-install.test.ts']);
});

test('check:pr expands npm run build through scripts and workspaces, in order, without the executable compile', () => scratch((root) => {
  write(root, { 'package.json': JSON.stringify({ scripts: { build: 'npm run build -w @x/a && npm run build -w @x/b' } }),
    'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { build: 'bun build.mjs' } }),
    'packages/b/package.json': JSON.stringify({ name: '@x/b', scripts: { build: 'npm run ui && npm run codegen && npm run build:binary && npm run build:verify',
      ui: 'node check.mjs && cd ui && npx vite build', codegen: 'tsx gen-one.ts && node gen-two.mjs', 'build:binary': 'x', 'build:verify': 'y' } }) });
  expect(buildSteps(root).map(({ cwd, command }) => `${cwd}: ${command}`)).toEqual(['packages/a: bun build.mjs', 'packages/b: node check.mjs',
    'packages/b/ui: npx vite build', 'packages/b: tsx gen-one.ts', 'packages/b: node gen-two.mjs']);
  expect(buildSteps(REPO).map((step) => step.command))
    .toEqual(expect.arrayContaining(JSON.parse(fs.readFileSync(path.join(REPO, 'packages/myco/package.json'), 'utf8')).scripts.codegen.split(' && ')));
}));

test('check:pr reads --skip-importers and --jobs, and refuses anything else', () => {
  expect([parseArgs([], 16), parseArgs(['--skip-importers', '--jobs', '3'], 16), parseArgs(['--jobs=2'], 2)])
    .toEqual([{ skipImporters: false, jobs: 8 }, { skipImporters: true, jobs: 3 }, { skipImporters: false, jobs: 2 }]);
  expect([() => parseArgs(['--jobs', '0'], 16), () => parseArgs(['--fast'], 16)].map((call) => { try { call(); } catch (error) { return (error as Error).message; } }))
    .toEqual(['--jobs takes a positive whole number of test shards, not 0', 'Unknown check:pr option --fast; options are --skip-importers and --jobs <shards>']);
});

test('a file that fails in its shard and passes by itself fails no step, is run one at a time, and the final line names it', async () => {
  const [order, counter] = [[] as string[], { running: 0 }];
  const outcome = await retryAlone({ failing: ['tests/a.test.ts', 'tests/b.test.ts'], runAlone: async (file) => {
    order.push(`${file} ${++counter.running}`); await new Promise((resolve) => setTimeout(resolve, 5)); counter.running--; return file === 'tests/a.test.ts';
  } });
  expect([outcome, order]).toEqual([{ confirmed: ['tests/b.test.ts'], passedOnRerun: ['tests/a.test.ts'] }, ['tests/a.test.ts 1', 'tests/b.test.ts 1']]);
  expect(summaryLine({ passed: 3, failed: 0, seconds: 9, base: 'fef832746abc', notRun: [{ what: 'Windows ARM64 smoke', why: 'CI only' }], passedOnRerun: outcome.passedOnRerun }))
    .toBe('check:pr: 3 passed, 0 failed in 9 s (base fef832746); failed in its shard, passed when run again: tests/a.test.ts; not run here: Windows ARM64 smoke (CI only)');
});

test('when a lane rejects, the others are cancelled and settle before the summary is printed last', async () => {
  const [printed, cancels]: [string[], unknown[]] = [[], []];
  const slow = new Promise<void>((resolve) => setTimeout(() => resolve(void printed.push('PASS slow lane')), 20));
  const reasons = await settleLanes([Promise.reject(new Error('plan failed')), slow], (reason: unknown) => cancels.push(reason)).finally(() => printed.push('check:pr: summary'));
  expect([printed, reasons.map((reason) => (reason as Error).message), cancels.length]).toEqual([['PASS slow lane', 'check:pr: summary'], ['plan failed'], 1]);
});

const run = async (command: string, _args: string[], { cwd }: { cwd: string }) => ((result) => result.status === 0 ? result.stdout
  : Promise.reject(Object.assign(new Error(result.stdout + result.stderr), { output: result.stdout + result.stderr })))(spawnSync(command, { cwd, shell: true, encoding: 'utf8' }));
const dockerfile = ['FROM oven/bun:1.4.0-slim AS build', 'WORKDIR /build', 'COPY server/src ./src', 'COPY shared/src ./shared/src',
  'RUN bun build src/main.ts --target=bun --outfile=/build/server.js', 'FROM oven/bun:1.4.0-slim AS runtime', 'COPY server/run.sh ./run.sh'].join('\n');
const outcome = (files: Record<string, string>, runtimeCopy = 'COPY --from=build /build/server.js ./server.js') => scratch((dir) => {
  write(path.join(dir, 'context'), { Dockerfile: `${dockerfile}\n${runtimeCopy}`, 'server/src/main.ts': "import { word } from '../shared/src/word.ts';\nconsole.log(word);\n", ...files });
  return imageInputs({ context: path.join(dir, 'context'), dockerfile: 'Dockerfile', scratch: path.join(dir, 'image'), run, mirrorModules: () => {} })
    .then((notes) => ['built', ...notes].join('\n'), (error: Error) => error.message);
});

test('check:pr image inputs pass when every file the bundle resolves is copied, and name the stage and file when one is not', async () => {
  const word = "export const word = 'ok';\n";
  expect(await outcome({ 'shared/src/word.ts': word, 'server/run.sh': '' })).toBe('built');
  const missing = await outcome({ 'shared/src/word.ts': "import data from '../data.json';\nexport const word = data.word;\n", 'shared/data.json': '{"word":"ok"}', 'server/run.sh': '' });
  expect([missing.includes('build: RUN bun build src/main.ts'), missing.includes('../data.json')]).toEqual([true, true]);
  expect(await outcome({ 'shared/src/word.ts': word })).toBe('runtime: COPY server/run.sh: no such file in the build context');
  expect(await outcome({ 'shared/src/word.ts': word, 'server/run.sh': '' }, 'COPY --from=build /build/missing.js ./server.js')).toBe('runtime: COPY --from=build /build/missing.js: stage build does not produce it');
});

test('the runner plans only the files a selection file lists, in the full run\'s groups, and takes no targets beside it', () => scratch((dir) => {
  const chosen = ['tests/myco-shared/command-shape.test.ts', 'tests/scripts/test-shards.test.ts'];
  fs.writeFileSync(path.join(dir, 'selection.txt'), `${chosen.join('\n')}\n`);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key))), TMPDIR: dir, MYCO_RUNNER_DRY_RUN: '1',
    MYCO_TEST_SELECTION_FILE: path.join(dir, 'selection.txt'), MYCO_RUNNER_PLAN_FILE: path.join(dir, 'plan.json'), MYCO_RUNNER_REPORT_DIR: path.join(dir, 'reports') };
  const runner = (args: string[]) => spawnSync('node', ['scripts/run-bun-tests.mjs', ...args], { cwd: REPO, encoding: 'utf8', env });
  expect(((planned) => [planned.status, planned.stderr.includes('FAIL')])(runner([]))).toEqual([0, false]);
  const phases = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) as Array<{ label: string; files: string[] }>;
  expect([phases.flatMap((phase) => phase.files).sort(), phases.find((phase) => phase.files.includes(chosen[0]!))?.label]).toEqual([chosen, 'node env shared tests-myco-shared']);
  expect(runner([chosen[1]!]).stderr).toContain('MYCO_TEST_SELECTION_FILE selects the files; pass no test targets with it');
}), 60_000);
