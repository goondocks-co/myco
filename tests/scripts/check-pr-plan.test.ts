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
const select = (changed: string[], tests: string[] = []) => selectConsumers({ changed, tests, windowsTests });
const names = (changed: string[], tests: string[] = []) => select(changed, tests).map((row) => row.name);

function scratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-check-pr-plan-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

describe('check:pr consumers', () => {
  test('a new shared data file selects the installer tests, the image inputs and the dashboard screens, and nothing compiled', () => {
    expect(names(['packages/myco-shared/release-channels.json'])).toEqual(['installer and source install', 'self-hosted image inputs', 'dashboard screens']);
  });

  test('a sign-in, hook or harness change selects the compiled sign-in and hook startup checks', () => {
    for (const file of ['packages/myco/src/cli/login.ts', 'packages/myco/src/hooks/dispatch.ts', 'packages/myco/src/symbionts/manifests/copilot.yaml']) {
      expect(names([file])).toEqual(['compiled sign-in', 'compiled hook startup']);
    }
  });

  test('installer scripts, the Makefile and both install scripts select the installer tests', () => {
    for (const file of ['packages/myco/scripts/install-marker.mjs', 'Makefile', 'install.sh', 'install.ps1']) {
      expect(names([file])).toContain('installer and source install');
    }
  });

  test('the image build file selects the image inputs check', () => {
    expect(names(['packages/myco-server/Dockerfile'])).toEqual(['self-hosted image inputs']);
  });

  test('a product change that no consumer reads selects no row', () => {
    expect(names(['packages/myco/src/member/registry.ts', 'packages/myco/skills/myco-setup/SKILL.md'])).toEqual([]);
  });

  test('parity, the compiled routing smoke and the Windows contracts are selected by the tests a change reaches', () => {
    expect(names(['packages/myco/src/member/registry.ts'], ['tests/parity/parity.test.ts'])).toEqual(['parity smoke (self-hosted)']);
    expect(names(['packages/myco/src/member/registry.ts'], ['tests/member/rbac-routing-smoke.test.ts'])).toEqual(['compiled repository routing']);
    const windows = select(['packages/myco/src/utils/git-files.ts'], ['tests/utils/git-files.test.ts']);
    expect(windows.map((row) => [row.name, row.ciOnly])).toEqual([['Windows contracts', 'it needs Windows']]);
  });

  test('a change to tooling the Darwin release recipe reads says that recipe is left to CI', () => {
    const rows = select(['scripts/check-pr.mjs', 'tests/scripts/check-pr-plan.test.ts']);
    expect(rows.map((row) => [row.name, row.ciOnly])).toEqual([['Darwin release recipe', 'it cross-compiles and signs a release distribution']]);
  });

  test('each selected row names the paths that selected it', () => {
    const [row] = select(['packages/myco-server/Dockerfile', 'packages/myco/src/member/registry.ts']);
    expect(row?.reasons).toEqual(['packages/myco-server/Dockerfile']);
  });

  test('every row stands in for a job the CI workflow has', () => {
    const workflow = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8'));
    const jobs = Object.entries(workflow.jobs as Record<string, { name?: string }>).flatMap(([id, job]) => [id, (job.name ?? '').split(' (')[0]]);
    for (const row of CONSUMERS) expect({ row: row.name, job: jobs.some((job) => job !== '' && row.ci.startsWith(job)) }).toEqual({ row: row.name, job: true });
  });

  test('the installer row runs the source install and installer tests', () => {
    const installer = CONSUMERS.find((row) => row.name === 'installer and source install')!;
    expect(rowTestFiles(installer, ['tests/install/install-sh.test.ts', 'tests/install/install-ps1-fixture.ts', 'tests/scripts/source-install.test.ts', 'tests/cli/login.test.ts']))
      .toEqual(['tests/install/install-sh.test.ts', 'tests/scripts/source-install.test.ts']);
  });
});

describe('check:pr generators', () => {
  test('expands npm run build through scripts and workspaces, in order, without the executable compile', () => scratch((root) => {
    write(root, {
      'package.json': JSON.stringify({ scripts: { build: 'npm run build -w @x/a && npm run build -w @x/b' } }),
      'packages/a/package.json': JSON.stringify({ name: '@x/a', scripts: { build: 'bun build.mjs' } }),
      'packages/b/package.json': JSON.stringify({ name: '@x/b', scripts: {
        build: 'npm run ui && npm run codegen && npm run build:binary && npm run build:verify',
        ui: 'node check.mjs && cd ui && npx vite build', codegen: 'tsx gen-one.ts && node gen-two.mjs',
        'build:binary': 'node compile.mjs', 'build:verify': 'node verify.mjs' } }),
    });
    expect(buildSteps(root).map(({ cwd, command }) => `${cwd}: ${command}`)).toEqual([
      'packages/a: bun build.mjs', 'packages/b: node check.mjs', 'packages/b/ui: npx vite build',
      'packages/b: tsx gen-one.ts', 'packages/b: node gen-two.mjs',
    ]);
  }));

  test('the repository build runs every codegen generator', () => {
    const codegen = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/myco/package.json'), 'utf8')).scripts.codegen.split('&&').map((part: string) => part.trim());
    const steps = buildSteps(REPO).filter((step) => step.cwd === 'packages/myco').map((step) => step.command);
    for (const command of codegen) expect(steps).toContain(command);
  });
});

describe('check:pr options and final line', () => {
  test('reads --skip-importers and --jobs, and refuses anything else with the options it takes', () => {
    expect(parseArgs([], 16)).toEqual({ skipImporters: false, jobs: 8 });
    expect(parseArgs(['--skip-importers', '--jobs', '3'], 16)).toEqual({ skipImporters: true, jobs: 3 });
    expect(parseArgs(['--jobs=2'], 2)).toEqual({ skipImporters: false, jobs: 2 });
    expect(() => parseArgs(['--jobs', '0'], 16)).toThrow('--jobs takes a positive whole number');
    expect(() => parseArgs(['--fast'], 16)).toThrow('options are --skip-importers and --jobs <shards>');
  });

  test('gives counts and says nothing was left when everything ran', () => {
    expect(summaryLine({ passed: 20, failed: 0, seconds: 300, base: 'fef832746abcdef', notRun: [] }))
      .toBe('check:pr: 20 passed, 0 failed in 300 s (base fef832746)');
  });

  test('names what was not run and the flag or rule that left it', () => {
    const line = summaryLine({ passed: 18, failed: 1, seconds: 90, base: 'fef832746abcdef', notRun: [
      { what: '144 importing test files', why: '--skip-importers' },
      { what: 'Windows contracts [windows-native: Windows smoke contracts]', why: 'left to CI: it needs Windows' },
    ] });
    expect(line).toBe('check:pr: 18 passed, 1 failed in 90 s (base fef832746); not run here: 144 importing test files (--skip-importers); '
      + 'Windows contracts [windows-native: Windows smoke contracts] (left to CI: it needs Windows)');
  });
});

/** Runs a shell command the way check:pr does, rejecting with its output. */
function run(command: string, _args: string[], { cwd }: { cwd: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => code === 0 ? resolve(output) : reject(Object.assign(new Error(output), { output })));
  });
}

describe('check:pr image inputs', () => {
  const dockerfile = [
    'FROM oven/bun:1.4.0-slim AS build',
    'WORKDIR /build',
    'COPY server/src ./src',
    'COPY shared/src ./shared/src',
    'RUN bun build src/main.ts --target=bun --outfile=/build/server.js',
    'FROM oven/bun:1.4.0-slim AS runtime',
    'COPY --from=build /build/server.js ./server.js',
    'COPY server/entrypoint.sh ./entrypoint.sh',
  ].join('\n');
  const inputs = (context: string, dir: string) => imageInputs({ context, dockerfile: 'Dockerfile', scratch: path.join(dir, 'image'), run, mirrorModules: () => {} });

  test('passes when every file the bundle resolves is copied', () => scratch(async (dir) => {
    const context = path.join(dir, 'context');
    write(context, { Dockerfile: dockerfile, 'server/src/main.ts': "import { word } from '../shared/src/word.ts';\nconsole.log(word);\n",
      'shared/src/word.ts': "export const word = 'ok';\n", 'server/entrypoint.sh': '#!/bin/sh\n' });
    await inputs(context, dir);
  }));

  test('fails naming the stage and the file when the bundle reaches a file the build file does not copy', () => scratch(async (dir) => {
    const context = path.join(dir, 'context');
    write(context, { Dockerfile: dockerfile, 'server/src/main.ts': "import { word } from '../shared/src/word.ts';\nconsole.log(word);\n",
      'shared/src/word.ts': "import data from '../data.json';\nexport const word = data.word;\n", 'shared/data.json': '{"word":"ok"}',
      'server/entrypoint.sh': '#!/bin/sh\n' });
    const failure = await inputs(context, dir).then(() => null, (error: Error) => error.message);
    expect(failure).toContain('build: RUN bun build src/main.ts');
    expect(failure).toContain('../data.json');
  }));

  test('fails when a COPY names a file the context lacks', () => scratch(async (dir) => {
    const context = path.join(dir, 'context');
    write(context, { Dockerfile: dockerfile, 'server/src/main.ts': "console.log('ok');\n", 'shared/src/word.ts': '' });
    const failure = await inputs(context, dir).then(() => null, (error: Error) => error.message);
    expect(failure).toBe('runtime: COPY server/entrypoint.sh: no such file in the build context');
  }));
});

describe('the runner over a selection file', () => {
  test('plans only the selected files, with the full run\'s groups', () => scratch((dir) => {
    const selection = path.join(dir, 'selection.txt');
    const plan = path.join(dir, 'plan.json');
    const chosen = ['tests/scripts/test-shards.test.ts', 'tests/myco-shared/command-shape.test.ts'];
    fs.writeFileSync(selection, `${chosen.join('\n')}\n`);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
    const result = spawnSync('node', ['scripts/run-bun-tests.mjs'], { cwd: REPO, encoding: 'utf8', env: { ...inherited,
      MYCO_TEST_SELECTION_FILE: selection, MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_PLAN_FILE: plan,
      MYCO_RUNNER_REPORT_DIR: path.join(dir, 'reports'), TMPDIR: dir } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const phases = JSON.parse(fs.readFileSync(plan, 'utf8')) as Array<{ label: string; files: string[] }>;
    expect(phases.flatMap((phase) => phase.files).sort()).toEqual([...chosen].sort());
    expect(phases.find((phase) => phase.files.includes('tests/myco-shared/command-shape.test.ts'))?.label).toBe('node env shared tests-myco-shared');
  }), 60_000);

  test('refuses test targets beside a selection file', () => scratch((dir) => {
    const selection = path.join(dir, 'selection.txt');
    fs.writeFileSync(selection, 'tests/scripts/test-shards.test.ts\n');
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
    const result = spawnSync('node', ['scripts/run-bun-tests.mjs', 'tests/scripts/test-shards.test.ts'], { cwd: REPO, encoding: 'utf8',
      env: { ...inherited, MYCO_TEST_SELECTION_FILE: selection, MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_REPORT_DIR: path.join(dir, 'reports'), TMPDIR: dir } });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MYCO_TEST_SELECTION_FILE selects the files; pass no test targets with it');
  }), 60_000);
});
