// What `npm run check:pr` runs for a set of changed paths, kept apart from running it so it can be read and tested.
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { requiresDarwinRecipe } from './darwin-release-inputs.mjs';

/** A pattern is an exact path, or a directory prefix ending in `/**`. */
export function pathMatches(pattern, file) {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

const CLI_AND_HOOKS = ['packages/myco/src/cli/**', 'packages/myco/src/hooks/**', 'packages/myco/src/symbionts/**'];

/**
 * Checks that consume a change without importing it, selected by what changed. Each row names the CI job or step it
 * stands in for. `when.paths` matches changed paths; `when.tests` matches a selected test file (changed or importing);
 * `when.changed` is a predicate over every changed path. A row with `tests` adds those test files to the sharded test
 * run; a row with `check` runs that check; a row with `ciOnly` cannot run on this machine and says why.
 */
export const CONSUMERS = [
  {
    name: 'installer and source install',
    ci: 'tests (node): tests/scripts/source-install.test.ts runs make source-install; tests/install',
    when: { paths: ['packages/myco/scripts/**', 'Makefile', 'install.sh', 'install.ps1', 'packages/myco-shared/**'] },
    tests: ['tests/install/**', 'tests/scripts/source-install.test.ts', 'tests/scripts/make-dogfood.test.ts'],
  },
  {
    name: 'self-hosted image inputs',
    ci: 'self-hosted-container: Build for both architectures',
    when: { paths: ['packages/myco-shared/**', 'packages/myco-server/Dockerfile', 'packages/myco-server/src/**',
      'packages/myco-server/ui/**', 'packages/myco-server/migrations/**', 'packages/myco-server/docker-entrypoint.sh', '.dockerignore'] },
    check: 'image',
  },
  {
    name: 'compiled sign-in',
    ci: 'hook startup (linux-x64, linux-arm64): Check compiled sign-in exits',
    when: { paths: CLI_AND_HOOKS },
    check: 'compiled-sign-in',
  },
  {
    name: 'compiled hook startup',
    ci: 'hook startup: Measure a no-op hook; Measure every hook at work',
    when: { paths: CLI_AND_HOOKS },
    check: 'hook-startup',
  },
  {
    name: 'compiled repository routing',
    ci: 'build: One machine routes each repository to its explicit Deployment',
    when: { tests: ['tests/member/rbac-routing-smoke.test.ts'] },
    check: 'compiled-routing',
  },
  {
    name: 'parity smoke (self-hosted)',
    ci: 'parity-smoke: npm run test:parity with MYCO_PARITY_SCOPE=smoke',
    when: { tests: ['tests/parity/parity.test.ts'], paths: ['tests/parity/**'] },
    check: 'parity',
  },
  {
    name: 'dashboard screens',
    ci: 'ui-screens: shell, setup and auth-setup screens',
    when: { paths: ['packages/myco-server/ui/**', 'packages/myco-shared/**', 'tests/ui-screens/**'] },
    check: 'screens',
  },
  {
    name: 'docs site',
    ci: 'lint: Build docs site',
    when: { paths: ['docs/**'] },
    check: 'docs',
  },
  {
    name: 'Windows contracts',
    ci: 'windows-native: Windows smoke contracts',
    when: { tests: 'windows-native' },
    ciOnly: 'it needs Windows',
  },
  {
    name: 'Darwin release recipe',
    ci: 'darwin-release-build and darwin-release-verify',
    when: { changed: (paths) => requiresDarwinRecipe('pull_request', paths) },
    ciOnly: 'it cross-compiles and signs a release distribution',
  },
];

/** The test files a CI step names on its `npm test --` line. */
export function workflowStepTests(root, job, stepName) {
  const workflow = parseYaml(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const step = workflow.jobs[job]?.steps.find((one) => one.name === stepName);
  if (!step) throw new Error(`.github/workflows/ci.yml has no ${job} step named ${stepName}`);
  return step.run.split(/\s+/).filter((word) => /^tests\/.*\.test\.tsx?$/.test(word));
}

/**
 * The rows a change selects, each with the paths or tests that selected it.
 * @param {{ changed: string[], tests: string[], windowsTests: string[] }} input changed paths, the selected test files
 *   (changed and importing), and the Windows job's test files
 */
export function selectConsumers({ changed, tests, windowsTests }) {
  const selected = [];
  for (const row of CONSUMERS) {
    const reasons = [];
    for (const pattern of row.when.paths ?? []) reasons.push(...changed.filter((file) => pathMatches(pattern, file)));
    const watched = row.when.tests === 'windows-native' ? windowsTests : row.when.tests ?? [];
    reasons.push(...tests.filter((file) => watched.includes(file)));
    if (row.when.changed?.(changed)) reasons.push(...changed);
    if (reasons.length) selected.push({ ...row, reasons: [...new Set(reasons)].sort() });
  }
  return selected;
}

/** The test files a row's `tests` patterns name, among the files present. */
export function rowTestFiles(row, files) {
  return files.filter((file) => /\.test\.tsx?$/.test(file) && (row.tests ?? []).some((pattern) => pathMatches(pattern, file)));
}

/** Commands that build or check the executable; the compiled-binary rows run them, not the generator check. */
const EXECUTABLE_SCRIPTS = new Set(['build:binary', 'build:verify']);

/**
 * Every command `npm run build` runs, expanded through `npm run` and workspaces, in order, except the executable's own
 * compile and verification. Each step has the package directory it runs in, relative to the root, and the scripts
 * that led to it.
 */
export function buildSteps(root) {
  const packages = new Map();
  const readPackage = (dir) => JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  for (const name of fs.readdirSync(path.join(root, 'packages'))) {
    const dir = `packages/${name}`;
    if (fs.existsSync(path.join(root, dir, 'package.json'))) packages.set(readPackage(dir).name, dir);
  }
  const steps = [];
  const expand = (dir, script, trail) => {
    const text = readPackage(dir).scripts?.[script];
    if (text === undefined) throw new Error(`${dir || '.'}/package.json has no ${script} script`);
    let cwd = dir;
    for (const part of text.split('&&').map((one) => one.trim())) {
      const run = part.match(/^npm run ([\w:-]+)(?:\s+(?:-w|--workspace)\s+(\S+))?$/);
      const cd = part.match(/^cd (\S+)$/);
      if (run) {
        const [, name, workspace] = run;
        if (EXECUTABLE_SCRIPTS.has(name)) continue;
        const target = workspace === undefined ? cwd : packages.get(workspace);
        if (target === undefined) throw new Error(`npm run ${name} -w ${workspace}: no such workspace`);
        expand(target, name, [...trail, `${name}${workspace ? ` -w ${workspace}` : ''}`]);
      } else if (cd) {
        cwd = path.posix.normalize(path.posix.join(cwd, cd[1]));
      } else {
        steps.push({ cwd: cwd || '.', command: part, from: trail.join(' > ') });
      }
    }
  };
  expand('', 'build', ['build']);
  return steps;
}

/** Reads `check:pr`'s own flags. */
export function parseArgs(argv, cpus) {
  const options = { skipImporters: false, jobs: Math.max(1, Math.min(8, Math.floor(cpus / 2))) };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--skip-importers') options.skipImporters = true;
    else if (arg === '--jobs' || arg.startsWith('--jobs=')) {
      const value = arg.includes('=') ? arg.slice('--jobs='.length) : argv[++index];
      if (!/^[1-9]\d*$/.test(value ?? '')) throw new Error(`--jobs takes a positive whole number of test shards, not ${value}`);
      options.jobs = Number(value);
    } else throw new Error(`Unknown check:pr option ${arg}; options are --skip-importers and --jobs <shards>`);
  }
  return options;
}

/** The final line: counts, and anything not run here with the flag or rule that left it to CI. */
export function summaryLine({ passed, failed, seconds, base, notRun }) {
  const tail = notRun.length ? `; not run here: ${notRun.map(({ what, why }) => `${what} (${why})`).join('; ')}` : '';
  return `check:pr: ${passed} passed, ${failed} failed in ${seconds} s (base ${base.slice(0, 9)})${tail}`;
}
