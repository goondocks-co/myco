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
/** What a compiled hook runs and how CI builds and measures it. */
const HOOK_BINARY = ['packages/myco/src/**', 'packages/myco-shared/src/**', 'packages/myco/scripts/build-single-target.mjs',
  'packages/myco/scripts/build-libsqlite3-target.sh', 'packages/myco/scripts/measure-hook-startup.mjs',
  'packages/myco/scripts/measure-hook-work.ts', '.bun-version', 'package-lock.json'];
/** What the self-hosted image is built from, and the scripts that boot it and check its data survives replacement. */
const IMAGE = ['packages/myco-shared/**', 'packages/myco-server/Dockerfile', 'packages/myco-server/src/**', 'packages/myco-server/ui/**',
  'packages/myco-server/migrations/**', 'packages/myco-server/docker-entrypoint.sh', '.dockerignore', 'package-lock.json'];

/**
 * Checks that consume a change without importing it, selected by what changed. Each row names the CI job or step it
 * stands in for. `when.paths` matches changed paths; `when.tests` matches a reached test file (changed or importing),
 * or names a windows-native step list; `when.changed` is a predicate over every changed path. A row with `tests` adds
 * those test files to the sharded test run; a row with `check` runs that check; `requires` names the tools its tests or
 * check need, without which they would skip or cannot run; a row with `ciOnly` runs nothing here and says why.
 */
export const CONSUMERS = [
  {
    name: 'installer and source install',
    ci: 'tests (node): tests/scripts/source-install.test.ts runs make source-install; tests/install',
    when: { paths: ['packages/myco/scripts/**', 'Makefile', 'docs/install.sh', 'docs/install.ps1', 'packages/myco-shared/**'] },
    tests: ['tests/install/**', 'tests/scripts/source-install.test.ts', 'tests/scripts/make-dogfood.test.ts'],
    requires: ['pwsh', 'cc', 'shellcheck'],
  },
  {
    name: 'self-hosted image inputs (build inputs only)',
    ci: 'self-hosted-container: Build for both architectures',
    when: { paths: IMAGE },
    check: 'image',
  },
  {
    name: 'native Deployment lifecycle',
    ci: 'tests (node, full run): tests/server/local-lifecycle-*.test.ts, which boot a native Deployment',
    when: { paths: ['packages/myco-server/src/**'] },
    tests: ['tests/server/local-lifecycle-inspection.test.ts', 'tests/server/local-lifecycle-prepare.test.ts', 'tests/server/local-lifecycle-preserve.test.ts'],
  },
  {
    name: 'harness configuration',
    ci: 'tests (node, full run): tests/member, tests/hooks and tests/symbionts run hooks through each harness\'s generated configuration',
    when: { paths: ['packages/myco/src/symbionts/manifests/**', 'packages/myco/src/symbionts/templates/**', 'packages/myco/src/symbionts/manifest-schema.ts',
      'packages/myco/src/symbionts/manifests.generated.ts', 'packages/myco/src/hooks/hook-config.generated.ts', 'packages/myco/scripts/gen-hook-config.ts'] },
    tests: ['tests/member/**', 'tests/hooks/**', 'tests/symbionts/**'],
  },
  {
    name: 'member doctor CLI consumers',
    ci: 'tests (node): member CLI doctor dispatch and entry contracts',
    when: { paths: ['packages/myco/src/cli/member-doctor.ts', 'packages/myco/src/cli/doctor-member.ts', 'packages/myco/src/cli/doctor-output.ts', 'packages/myco/src/cli/doctor-capture.ts'] },
    tests: ['tests/cli/doctor-home.test.ts', 'tests/cli/member-machine-verbs.test.ts', 'tests/cli/member-reads-dispatch.test.ts', 'tests/cli/runtime-redirect.test.ts', 'tests/cli/retired-verbs.test.ts', 'tests/entries/windows-arm64-entry.test.ts', 'tests/member/repository-ownership.test.ts'],
  },
  {
    name: 'compiled sign-in',
    ci: 'hook startup (linux-x64, linux-arm64): Check compiled sign-in exits',
    when: { paths: CLI_AND_HOOKS },
    check: 'compiled-sign-in',
    requires: ['python3'],
  },
  {
    name: 'compiled hook startup on this machine',
    ci: 'hook startup (darwin-arm64): Measure a no-op hook; Measure every hook at work',
    when: { paths: HOOK_BINARY },
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
    requires: ['chromium'],
  },
  {
    name: 'docs site',
    ci: 'lint: Build docs site',
    when: { paths: ['docs/**'] },
    check: 'docs',
  },
  {
    name: 'hook startup on Linux',
    ci: 'hook startup (linux-x64, linux-arm64): Check compiled sign-in exits; Measure a no-op hook; Measure every hook at work',
    when: { paths: HOOK_BINARY },
    ciOnly: 'it runs on Linux',
  },
  {
    name: 'hook startup on Windows',
    ci: 'hook startup (windows-x64, measured): Measure a no-op hook; Measure every hook at work',
    when: { paths: HOOK_BINARY },
    ciOnly: 'it runs on Windows',
  },
  {
    name: 'Windows ARM64 smoke',
    ci: 'windows-arm64: Smoke the Windows ARM64 binary; Measure a no-op hook',
    when: { paths: [...HOOK_BINARY, 'scripts/windows-arm64-smoke.ps1'] },
    ciOnly: 'it runs on Windows ARM64',
  },
  {
    name: 'Windows contracts',
    ci: 'windows-native: Windows smoke contracts, Full Windows unit contracts, Execute Windows native contract',
    when: { tests: 'windows-native', paths: ['tests/helpers/windows-native-contract.ts'] },
    ciOnly: 'it runs on Windows',
  },
  {
    name: 'installer under Windows PowerShell 5.1',
    ci: 'windows-native: The installer resolves a release under Windows PowerShell 5.1',
    when: { paths: ['docs/install.ps1'] },
    ciOnly: 'it runs on Windows PowerShell 5.1',
  },
  {
    name: 'parity, full run and Cloudflare target',
    ci: 'parity (1-8/8): npm run test:parity on both targets',
    when: { tests: ['tests/parity/parity.test.ts'], paths: ['tests/parity/**'] },
    ciOnly: 'lanes never boot the Cloudflare target, and the full run is CI\'s',
  },
  {
    name: 'self-hosted image build, boot and persistence',
    ci: 'self-hosted-container: Build for both architectures; Run the native image and smoke it; Preserve data across replacement',
    when: { paths: [...IMAGE, 'scripts/smoke-container-persistence.mjs', 'scripts/test-container-persistence-mutations.mjs'] },
    ciOnly: 'it builds and boots the image with Docker',
  },
  {
    name: 'Darwin release recipe',
    ci: 'darwin-release-build and darwin-release-verify',
    when: { changed: (paths) => requiresDarwinRecipe('pull_request', paths) },
    ciOnly: 'it cross-compiles and signs a release distribution',
  },
];

/** The test files the windows-native job's steps name on their `npm test --` lines. */
export function windowsJobTests(root) {
  const workflow = parseYaml(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  const steps = workflow.jobs['windows-native'].steps.filter((step) => /^npm test --/.test(step.run ?? ''));
  if (!steps.length) throw new Error('.github/workflows/ci.yml has no windows-native step that runs npm test');
  return [...new Set(steps.flatMap((step) => step.run.split(/\s+/).filter((word) => /^tests\/.*\.test\.tsx?$/.test(word))))];
}

/**
 * The rows a change selects, each with the paths or tests that selected it.
 * @param {{ changed: string[], tests: string[], windowsTests: string[] }} input changed paths, the reached test files
 *   (changed and importing), and the windows-native job's test files
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

/**
 * The selected rows that run here, and what the final line names as not run: a CI-only row, or a row missing a tool.
 * @param {{ changed: string[], tests: string[], windowsTests: string[], hasTool: (name: string) => boolean }} input
 */
export function planConsumers({ hasTool, ...input }) {
  const runnable = [];
  const notRun = [];
  for (const row of selectConsumers(input)) {
    const missing = (row.requires ?? []).filter((tool) => !hasTool(tool));
    if (row.ciOnly) notRun.push({ what: `${row.name} [${row.ci}]`, why: `CI only: ${row.ciOnly}` });
    else if (missing.length) notRun.push({ what: `${row.name} [${row.ci}]`, why: `${missing.join(', ')} not installed` });
    else runnable.push(row);
  }
  return { rows: runnable, notRun };
}

/** The test files a row's `tests` patterns name, among the files present. */
export function rowTestFiles(row, files) {
  return files.filter((file) => /\.test\.tsx?$/.test(file) && (row.tests ?? []).some((pattern) => pathMatches(pattern, file)));
}

/**
 * Runs each failing item again by itself, one after another. An item that fails again stays failed; one that passes is
 * reported as having failed in its shard and passed when run again, so it is named on the final line, not hidden.
 * @param {{ failing: Iterable<string>, runAlone: (item: string) => Promise<boolean> }} input
 */
export async function retryAlone({ failing, runAlone }) {
  const confirmed = [];
  const passedOnRerun = [];
  for (const item of failing) ((await runAlone(item)) ? passedOnRerun : confirmed).push(item);
  return { confirmed, passedOnRerun };
}

/**
 * Waits for every lane to settle. The first lane to reject cancels the rest, which then settle too; nothing is left
 * running when this returns, so the summary printed after it is the last line.
 * @returns {Promise<unknown[]>} the reasons lanes rejected with, first rejection first
 */
export async function settleLanes(lanes, cancel) {
  const reasons = [];
  await Promise.all(lanes.map((lane) => Promise.resolve(lane).catch((reason) => {
    if (!reasons.length) cancel(reason);
    reasons.push(reason);
  })));
  return reasons;
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

/** The final line: counts, what failed in its shard and passed when run again, and anything not run here and why. */
export function summaryLine({ passed, failed, seconds, base, notRun, passedOnRerun = [] }) {
  const rerun = passedOnRerun.length ? `; failed in its shard, passed when run again: ${passedOnRerun.join(', ')}` : '';
  const tail = notRun.length ? `; not run here: ${notRun.map(({ what, why }) => `${what} (${why})`).join('; ')}` : '';
  return `check:pr: ${passed} passed, ${failed} failed in ${seconds} s (base ${base.slice(0, 9)})${rerun}${tail}`;
}
