#!/usr/bin/env node
// Runs, before a push, what pull request CI most often fails on. Usage: npm run check:pr [-- --skip-importers] [-- --jobs N]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { BUILD_JOB_FILES, HEAVY_AND_SCALE_SUITES } from './ci-scopes.mjs';
import { nestedRunnerEnvKeys } from './check-test-shards.mjs';
import { installRoots, staleReason } from './ensure-deps.mjs';
import { affectedTests } from './pr-test-selection.mjs';
import { buildSteps, parseArgs, planConsumers, retryAlone, rowTestFiles, settleLanes, summaryLine, windowsJobTests } from './check-pr-plan.mjs';
import { imageInputs } from './check-pr-image.mjs';
import { CHILD_HOME_NAMES } from './test-environment.mjs';
import { resolveTestTool } from './test-tool-path.mjs';
import { binaryFileName, hostReleaseTarget } from '../packages/myco/scripts/release-targets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const started = performance.now();
const options = parseArgs(process.argv.slice(2), os.availableParallelism());
const children = new Set();
let interrupted;
let cancelled;
function signalChildren(signal) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  interrupted = signal;
  signalChildren(signal);
});
/** Stops every lane: no new command starts, and the running ones are ended with their process groups. */
function cancelAll(reason) {
  cancelled ??= reason instanceof Error ? reason.message.split('\n')[0] : String(reason);
  signalChildren('SIGTERM');
}
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PARITY = 'tests/parity/parity.test.ts';
const CARRIER = 'packages/myco/src/server-ui-assets.generated.ts';
const BUNDLE_STEP = 'Build the standalone dashboard from source without shared build artifacts';
const bundleFix = 'npm run build:ui';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const checkRoot = path.join(root, 'target', 'check-pr');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-check-pr-'));
// Every command this check starts sees a home of its own, laid out as the test runner's sandbox lays it out, so no
// generator, npm, type check or test writes to the caller's home or reads its agent configuration.
const home = fs.mkdtempSync(path.join(scratch, 'h-'));
const homes = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_CONFIG_HOME: path.join(home, '.config'), MYCO_HOME: path.join(home, '.myco'), MYCO_LAUNCH_AGENTS_DIR: path.join(home, 'service-units'),
  MYCO_TEAM_HOME: path.join(home, '.myco-team') };
if (CHILD_HOME_NAMES.some(name => !(name in homes))) throw new Error(`check:pr does not isolate every home the test sandbox does: ${CHILD_HOME_NAMES}`);
const sandbox = { ...process.env, ...homes, npm_config_cache: path.join(home, '.npm') };
const notRun = [];
const passedOnRerun = [];
let passed = 0;
let failed = 0;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

class Stop extends Error {}
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
// npm reports a child stopped by a signal as exit 128 + the signal number.
const STOP_STATUSES = new Map([[129, 'SIGHUP'], [130, 'SIGINT'], [143, 'SIGTERM']]);
const stopIfInterrupted = () => {
  if (interrupted) throw new Stop(`Interrupted by ${interrupted}`);
  if (cancelled) throw new Stop(`Cancelled: ${cancelled}`);
};

/** Runs a command to completion in its own process group; resolves with its output, rejects with it on failure. */
function run(tool, args, { cwd = root, env = sandbox, shell = false } = {}) {
  stopIfInterrupted();
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { cwd, env, shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let output = '';
    const take = chunk => {
      output += chunk;
      if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout.setEncoding('utf8').on('data', take);
    child.stderr.setEncoding('utf8').on('data', take);
    child.once('error', error => { children.delete(child); reject(error); });
    child.once('close', (code, signal) => {
      children.delete(child);
      if (cancelled) return reject(new Stop(`Cancelled: ${cancelled}`));
      if (STOP_SIGNALS.has(signal) || STOP_STATUSES.has(code)) interrupted ??= signal ?? STOP_STATUSES.get(code);
      if (interrupted) reject(new Stop(`Interrupted by ${interrupted}`));
      else if (code === 0) resolve(output);
      else reject(Object.assign(new Error(`${output}\nExit: ${code ?? signal}`), { output }));
    });
  });
}

/** `run` for the short gates that open the check, which run one after another. */
function command(tool, args, cwd = root) {
  stopIfInterrupted();
  const result = spawnSync(tool, args, { cwd, env: sandbox, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (STOP_SIGNALS.has(result.signal) || STOP_STATUSES.has(result.status)) interrupted ??= result.signal ?? STOP_STATUSES.get(result.status);
  stopIfInterrupted();
  if (result.error || result.status !== 0) {
    throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}\nExit: ${result.status ?? result.signal}`);
  }
}

function report({ name, ci, fix, start, error, output }) {
  if (error) failed++; else passed++;
  console.log(`${error ? 'FAIL' : 'PASS'} ${name} (${((performance.now() - start) / 1000).toFixed(1)} s)`);
  if (!error && output) console.log(output);
  if (error) console.error(`CI step: ${ci}\n${error.message}\nFix:\n${fix}`);
}

/** Runs one check, synchronous or not, and reports it; only an interruption escapes. A body may return `{ notes }` to print. */
async function check(name, ci, fix, body) {
  stopIfInterrupted();
  const start = performance.now();
  let error;
  let output;
  try { output = await body(); } catch (caught) {
    if (caught instanceof Stop) throw caught;
    error = caught;
  }
  report({ name, ci, fix, start, error, output: output?.notes });
  return !error;
}

/** The last lines of a long output, which is where a tool says why it failed. */
const tail = (text, lines = 60) => text.trimEnd().split('\n').slice(-lines).join('\n');

// ---------------------------------------------------------------------------
// Test shards: the runner's own plan, restricted to the selected files, split as CI splits it.
// ---------------------------------------------------------------------------

function runnerEnv(extra) {
  const env = { ...sandbox };
  for (const key of nestedRunnerEnvKeys) delete env[key];
  return { ...env, ...extra };
}

/** The runner's FAILURES and OVER BUDGET entries, each with the test files it names. */
function runnerFailures(output) {
  const entries = [];
  let section = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('=== FAILURES ===') || line.startsWith('=== OVER BUDGET')) { section = line; continue; }
    if (/^\d+ failures?\. Artifacts:/.test(line)) { section = null; continue; }
    if (/^\[run-bun-tests\] FAIL/.test(line)) entries.push({ text: line.trim() });
    else if (section && /^\[/.test(line)) entries.push({ text: line.trimEnd() });
    else if (section && line.trim() && entries.length) entries.at(-1).text += `\n${line.trimEnd()}`;
  }
  const named = entries.map(entry => ({ ...entry, files: new Set(entry.text.match(/tests\/[\w./@-]+?\.test\.tsx?/g) ?? []) }));
  return { lines: named.map(entry => entry.text), entries: named, files: new Set(named.flatMap(entry => [...entry.files])) };
}

async function testShards(groups) {
  const files = [...new Set(groups.flatMap(group => group.files))].sort();
  if (!files.length) return;
  const selectionFile = path.join(scratch, 'selection.txt');
  fs.writeFileSync(selectionFile, `${files.join('\n')}\n`);
  const planFile = path.join(scratch, 'plan.json');
  const base = { MYCO_TEST_SELECTION_FILE: selectionFile, MYCO_TEST_KIND: 'all' };
  const planned = await check('test plan', 'tests (node/dom shards): the runner\'s plan', `MYCO_RUNNER_DRY_RUN=1 MYCO_TEST_SELECTION_FILE=<selection> npm test`,
    () => run(process.execPath, ['scripts/run-bun-tests.mjs'], { env: runnerEnv({ ...base, MYCO_TEST_SHARD: '1/1',
      MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_PLAN_FILE: planFile, MYCO_RUNNER_REPORT_DIR: path.join(checkRoot, 'plan') }) }).then(() => undefined));
  if (!planned) return;
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const count = Math.max(1, Math.min(options.jobs, plan.length));
  const estimate = Math.round(plan.reduce((sum, phase) => sum + phase.estimatedMs, 0) / 1000);
  console.log(`Test shards: ${files.length} files in ${plan.length} groups (about ${estimate} s of CI runner time) across ${count} shards`);
  const start = performance.now();
  const shards = await Promise.all(Array.from({ length: count }, (_, index) => run(process.execPath, ['scripts/run-bun-tests.mjs'], {
    env: runnerEnv({ ...base, MYCO_TEST_SHARD: `${index + 1}/${count}`, MYCO_RUNNER_REPORT_DIR: path.join(checkRoot, `shard-${index + 1}`) }),
  }).then(output => ({ index, output, ok: true }), error => {
    if (error instanceof Stop) throw error;
    return { index, output: error.output ?? error.message, ok: false };
  })));
  const failures = shards.filter(shard => !shard.ok).map(shard => ({ ...shard, ...runnerFailures(shard.output) }));
  // A file that fails in its shard runs again by itself, one file at a time, in its own CI group. One that passes then
  // does not fail the step, and the final line names it.
  const firstFailing = [...new Set(failures.flatMap(failure => [...failure.files]))];
  const { confirmed, passedOnRerun: passedAlone } = await retryAlone({ failing: firstFailing, runAlone: async file => {
    const alone = path.join(scratch, 'alone.txt');
    fs.writeFileSync(alone, `${file}\n`);
    console.log(`Running ${file} again, by itself`);
    return run(process.execPath, ['scripts/run-bun-tests.mjs'], { env: runnerEnv({ MYCO_TEST_SELECTION_FILE: alone,
      MYCO_TEST_KIND: 'all', MYCO_TEST_SHARD: '1/1', MYCO_RUNNER_REPORT_DIR: path.join(checkRoot, 'alone') }) })
      .then(() => true, error => { if (error instanceof Stop) throw error; return false; });
  } });
  passedOnRerun.push(...passedAlone);
  const failingFiles = new Set(confirmed);
  const owned = new Set();
  for (const group of groups) {
    const mine = group.files.filter(file => !owned.has(file));
    mine.forEach(file => owned.add(file));
    if (!mine.length) continue;
    const failing = mine.filter(file => failingFiles.has(file));
    const lines = failures.flatMap(failure => failure.entries).filter(entry => failing.some(file => entry.files.has(file))).map(entry => entry.text);
    report({ name: `${group.name} (${mine.length} files)`, ci: group.ci, start,
      fix: `Fix the reported failures; npm test -- ${failing.map(quote).join(' ')}`,
      error: failing.length ? new Error(`Failing: ${failing.join(', ')}\n${lines.join('\n')}`) : undefined });
  }
  // A shard that failed without naming a selected file (a crash, a runner refusal) still fails the run.
  for (const failure of failures.filter(one => ![...one.files].some(file => owned.has(file)))) {
    report({ name: `test shard ${failure.index + 1}/${count}`, ci: 'tests (node/dom shards)', start,
      fix: `MYCO_TEST_SELECTION_FILE=<the files above> MYCO_TEST_SHARD=${failure.index + 1}/${count} npm test`,
      error: new Error(tail(failure.output)) });
  }
}

// ---------------------------------------------------------------------------
// The scratch copy: the build job's dashboard, every generator `npm run build` runs, and the compiled binary.
// ---------------------------------------------------------------------------

/** Recreates `node_modules` at `destination`: entries link to the install, workspace links resolve inside `packagesRoot`. */
function mirrorModules(source, destination, packagesRoot) {
  fs.mkdirSync(path.join(destination, '@goondocks'), { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === '@goondocks') continue;
    const from = path.join(source, entry.name);
    if (entry.isFile()) fs.copyFileSync(from, path.join(destination, entry.name));
    else fs.symlinkSync(fs.realpathSync(from), path.join(destination, entry.name), 'junction');
  }
  for (const name of fs.readdirSync(path.join(source, '@goondocks'))) {
    fs.symlinkSync(path.join(packagesRoot, name), path.join(destination, '@goondocks', name), 'junction');
  }
}

/** Every versioned and unignored file, copied; installed dependencies linked; shared build output absent as in CI. */
function copyCheckout(destination) {
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
  for (const file of new Set(files)) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) continue;
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(file), target);
    else fs.copyFileSync(file, target);
  }
  mirrorModules(path.join(root, 'node_modules'), path.join(destination, 'node_modules'), path.join(destination, 'packages'));
  for (const directory of ['packages/myco', 'packages/myco-server', 'packages/myco-server/ui', 'docs']) {
    const modules = path.join(root, directory, 'node_modules');
    if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(destination, directory, 'node_modules'), 'junction');
  }
}

/** Content hashes of every regular file in a copy, keyed by repository path; linked dependencies are not walked. */
function snapshot(directory) {
  const hashes = new Map();
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) hashes.set(file, createHash('sha1').update(fs.readFileSync(path.join(directory, file))).digest('hex'));
    }
  };
  walk('');
  return hashes;
}

/** Paths whose content differs between two snapshots, less those git ignores (tracked files are never ignored). */
function changedPaths(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort();
  if (!paths.length) return [];
  const result = spawnSync('git', ['check-ignore', '--stdin'], { cwd: root, input: paths.join('\n'), encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: ${result.stderr}`);
  const ignored = new Set(result.stdout.split('\n').filter(Boolean));
  return paths.filter(file => !ignored.has(file));
}

function stepEnv(copy, cwd) {
  const bins = [path.join(copy, cwd, 'node_modules/.bin'), path.join(copy, 'node_modules/.bin')];
  return { ...sandbox, PATH: [...bins, sandbox.PATH].join(path.delimiter) };
}

async function dashboard(copy) {
  await run(npm, ['run', 'build:ui'], { cwd: copy });
}

async function generators(copy, steps) {
  const stale = [];
  let before = snapshot(copy);
  for (const step of steps) {
    try {
      await run(step.command, [], { cwd: path.join(copy, step.cwd), env: stepEnv(copy, step.cwd), shell: true });
    } catch (error) {
      if (error instanceof Stop) throw error;
      throw new Error(`(cd ${step.cwd} && ${step.command}) failed, from npm run ${step.from}:\n${tail(error.message)}`);
    }
    const after = snapshot(copy);
    const changed = changedPaths(before, after);
    if (changed.length) stale.push({ step, changed });
    before = after;
  }
  if (stale.length) {
    throw new Error(stale.map(({ step, changed }) => `(cd ${step.cwd} && ${step.command}) changes:\n${changed.map(file => `  ${file}`).join('\n')}`).join('\n'));
  }
}

/**
 * The SQLite library the binary embeds, as CI's "Build the Linux SQLite library" step makes it: the checkout's own
 * build when it has one, else one built in the copy and kept under target/check-pr for the next run.
 */
async function nativeLibrary(copy, target) {
  const vendor = path.join(copy, 'packages/myco/vendor-src');
  for (const built of [path.join(root, 'packages/myco/vendor-src'), path.join(checkRoot, 'vendor-src')]) {
    if (fs.existsSync(path.join(built, 'libsqlite3', target))) {
      fs.symlinkSync(built, vendor, 'junction');
      return;
    }
  }
  await run('bash', ['packages/myco/scripts/build-libsqlite3-target.sh', target], { cwd: copy });
  fs.rmSync(path.join(checkRoot, 'vendor-src'), { recursive: true, force: true });
  fs.cpSync(vendor, path.join(checkRoot, 'vendor-src'), { recursive: true });
}

const generatorFix = steps => `Run the generators the build runs, then commit what they change:\n${steps.map(step => `(cd ${step.cwd} && ${step.command})`).join('\n')}`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let base = 'unknown';
const copy = path.join(scratch, 'checkout');
const browsers = path.join(root, 'target', 'playwright-browsers');
/** A tool a consumer row needs: Chromium where Playwright looks for it, anything else on PATH. */
const hasTool = name => name === 'chromium'
  ? fs.existsSync(browsers) && fs.readdirSync(browsers).some(entry => entry.startsWith('chromium'))
  : resolveTestTool(name) !== null;
const lanes = [];
/** Runs a check whose subject may fail on a busy machine; a failure is checked once more before it counts. */
async function againIfFailed(label, once) {
  try { return await once(); } catch (first) {
    if (first instanceof Stop) throw first;
    console.log(`${label}: failed; running it again by itself`);
    const output = await once();
    passedOnRerun.push(label);
    return output;
  }
}
try {
  base = git(['merge-base', 'origin/main', 'HEAD']).trim();
  const changed = [...new Set([
    ...git(['diff', '--name-only', '-z', '--no-renames', base]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
  if (git(['status', '--porcelain']).trim()) {
    console.warn('WARNING: dirty tree: check:test-budget reads HEAD for the line ratio. Commit your changes and rerun check:pr before pushing.');
  }
  const stale = installRoots.map(({ label, directory, removable }) => [label, staleReason(path.join(root, directory), undefined, removable)])
    .filter(([, reason]) => reason);
  await check('workspace dependencies', 'CI setup: install dependencies', 'node scripts/ensure-deps.mjs', () => {
    if (stale.length) throw new Error(`${stale.map(([label, reason]) => `${label} ${reason}`).join('; ')}; checks require dependencies from the lockfiles.`);
  });
  if (stale.length) throw new Stop('dependencies are stale; install them and rerun');
  const behind = git(['rev-list', '--count', `${base}..origin/main`]).trim();
  if (behind !== '0') console.warn(`WARNING: branch is ${behind} commits behind origin/main; CI tests the merge with current main. git fetch origin && git rebase origin/main`);
  await check('bun version', 'CI setup: oven-sh/setup-bun with .bun-version',
    'Put the pinned Bun first on PATH (the version in .bun-version), then npm run check:pr', () => {
      const pinned = fs.readFileSync('.bun-version', 'utf8').trim();
      const found = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim();
      if (found !== pinned) throw new Error(`bun ${found || 'not found'} is on PATH but CI runs ${pinned}; test results would differ from CI.`);
    });
  const host = hostReleaseTarget();
  await check('native SQLite library', 'tests (node): Restore the Linux SQLite library',
    `bash packages/myco/scripts/build-libsqlite3-target.sh ${host?.name ?? '<release target>'}`, () => {
      const vendor = path.join(root, 'packages/myco/vendor-src/libsqlite3');
      if (!fs.existsSync(vendor) || !fs.readdirSync(vendor).some(name => name.startsWith('sqlite-amalgamation-'))) {
        throw new Error('packages/myco/vendor-src/libsqlite3 holds no SQLite amalgamation: tests that measure reads compile against it, as CI builds it before its shards.');
      }
    });
  const gate = (name, script, ci, fix) => check(name, ci, fix,
    () => command(process.execPath, [`scripts/${script}.mjs`, base]));
  await gate('shipped migrations', 'check-shipped-migrations', 'Shipped migrations are unchanged and new ones append',
    'Restore shipped migrations; add a new schema step, then npm run migrations:emit -w @goondocks/myco-server');
  await gate('test additions', 'check-test-additions', 'Added test lines assert behaviour, not code',
    'Replace the reported added test statements with assertions of observable behaviour; npm run check:test-additions');
  await gate('test budget', 'check-test-budget', 'Test runner time and test-to-product ratio stay inside their budget',
    'Delete or demote redundant/heavy tests, commit, then npm run check:test-budget');
  await check('server gates', 'tests (node): tests/myco-server/gates.test.ts',
    'Reconcile runtime dependency pins and the server contract; npm test -- tests/myco-server/gates.test.ts',
    () => command(npm, ['test', '--', 'tests/myco-server/gates.test.ts']));
  // Before any parallel work: every runner and type check reads the Worker bundle this writes.
  await check('worker bundle preparation', 'lint (prelint)', 'npx tsx packages/myco/scripts/gen-worker-bundle.ts',
    () => command(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/gen-worker-bundle.ts']));
  await check('dashboard preparation', 'lint (prelint)', bundleFix,
    () => command(npm, ['run', 'build:ui']));

  // What runs: changed tests, the tests that import a changed file, PR-scope meta tests, and the consumer rows.
  const tracked = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'tests', 'scripts']).split('\0').filter(Boolean))];
  const affected = affectedTests({ root, files: tracked, changed });
  const separate = new Set([PARITY, ...BUILD_JOB_FILES, 'tests/myco-server/gates.test.ts']);
  const changedTests = affected.filter(({ tier }) => tier === 0).map(({ file }) => file).filter(file => !separate.has(file));
  const importers = affected.filter(({ tier }) => tier > 0).map(({ file }) => file).filter(file => !separate.has(file)).sort();
  const meta = changed.length ? tracked.filter(file => /^tests\/meta\/.*\.test\.tsx?$/.test(file) && !HEAVY_AND_SCALE_SUITES.includes(file)) : [];
  const windowsTests = windowsJobTests(root);
  const plan = planConsumers({ changed, tests: affected.map(({ file }) => file), windowsTests, hasTool });
  const { rows } = plan;
  notRun.push(...plan.notRun);
  console.log(`Changed tests: ${changedTests.length}; importing tests: ${importers.length}${options.skipImporters ? ' (skipped by --skip-importers)' : ''}; meta tests: ${meta.length}`);
  for (const row of rows) console.log(`Consumer: ${row.name} — stands in for ${row.ci}; selected by ${row.reasons.slice(0, 3).join(', ')}${row.reasons.length > 3 ? ` and ${row.reasons.length - 3} more` : ''}`);
  if (options.skipImporters && importers.length) {
    notRun.push({ what: `${importers.length} importing test files`, why: '--skip-importers' });
    console.warn(`Run importing tests: npm test -- ${importers.map(quote).join(' ')}`);
  }
  const groups = [
    { name: 'changed tests', ci: 'tests (node/dom shards)', files: changedTests },
    { name: 'meta tests (PR scope)', ci: 'tests (node): tests/meta in the PR scope', files: meta },
    ...rows.filter(row => row.tests).map(row => ({ name: row.name, ci: row.ci, files: rowTestFiles(row, tracked) })),
    { name: 'importing tests', ci: 'tests (node/dom shards); heavy suites in the full run', files: options.skipImporters ? [] : importers },
  ];
  const wants = check => rows.some(row => row.check === check);
  const compiled = ['compiled-sign-in', 'hook-startup', 'compiled-routing'].some(wants);
  const binary = host && path.join(copy, 'packages', `myco-${host.name}`, 'bin', binaryFileName(host));
  const steps = buildSteps(root);
  console.log(`Generators (from npm run build, less the executable's compile and verify): ${steps.map(step => step.command).join('; ')}`);

  // Three lanes at once: the test shards, the scratch copy's builds, and the type checks.
  const testsLane = testShards(groups);
  const parityLane = wants('parity') ? check('parity smoke (self-hosted)', 'parity-smoke: npm run test:parity (MYCO_PARITY_SCOPE=smoke)',
    'MYCO_PARITY_TARGET=selfhosted MYCO_PARITY_SCOPE=smoke npm run test:parity',
    async () => {
      try {
        await run(process.execPath, ['scripts/run-bun-tests.mjs', PARITY], { env: runnerEnv({ MYCO_PARITY: '1', MYCO_PARITY_SCOPE: 'smoke',
          MYCO_PARITY_TARGET: 'selfhosted', MYCO_RUNNER_GROUP_BUDGET_MS: '780000', MYCO_RUNNER_REPORT_DIR: path.join(checkRoot, 'parity') }) });
      } catch (error) {
        if (error instanceof Stop) throw error;
        const { lines } = runnerFailures(error.output ?? '');
        throw new Error(lines.length ? lines.join('\n') : tail(error.message));
      }
    }) : null;
  const buildLane = (async () => {
    let built = false;
    await check('scratch checkout', 'actions/checkout', 'Free space in the temp directory, then rerun', () => {
      copyCheckout(copy);
      built = true;
    });
    if (!built) return;
    if (wants('image')) {
      await check('self-hosted image inputs (build inputs only)', 'self-hosted-container: Build for both architectures',
        'Copy every file the image bundles in packages/myco-server/Dockerfile, or keep the bundle inside what it copies',
        async () => ({ notes: (await imageInputs({ context: copy, dockerfile: 'packages/myco-server/Dockerfile', scratch: path.join(scratch, 'image'), run, mirrorModules }))
          .map(note => `  note: ${note}`).join('\n') }));
    }
    if (changed.some(file => /^packages\/(?:myco-server|myco-shared)\//.test(file)
      || file === CARRIER || /(?:^|\/)(?:package\.json|npm-shrinkwrap\.json|package-lock\.json)$/.test(file)
      || file === 'tsconfig.json' || file === 'packages/myco/scripts/gen-ui-assets.ts')) {
      await check('dashboard bundle', BUNDLE_STEP, bundleFix, () => dashboard(copy));
    }
    await check(`generated files (${steps.length} build steps)`, 'build: Dev binary identifies the clean commit and generators preserve the checkout',
      generatorFix(steps), () => generators(copy, steps));
    if (wants('docs')) {
      await check('docs site', 'lint: Build docs site', 'npm ci --prefix docs && (cd docs && npm run build)', async () => {
        if (!fs.existsSync(path.join(root, 'docs/node_modules'))) throw new Error('docs/node_modules is missing: the docs site installs separately.');
        await run(process.execPath, ['build.mjs'], { cwd: path.join(copy, 'docs') });
      });
    }
    if (compiled) {
      if (!host) notRun.push({ what: 'compiled binary checks', why: `left to CI: no release target for ${process.platform}-${process.arch}` });
      else await check(`compiled binary (${host.name})`, 'hook startup: npm run build:binary -w @goondocks/myco',
        `TARGET=${host.name} npm run build:binary -w @goondocks/myco`,
        async () => {
          await nativeLibrary(copy, host.name);
          // The version stamp reads the real repository's tags, read-only.
          await run(npm, ['run', 'build:binary', '-w', '@goondocks/myco'], { cwd: copy,
            env: { ...sandbox, TARGET: host.name, GIT_DIR: git(['rev-parse', '--absolute-git-dir']).trim() } });
        });
    }
    if (wants('screens')) {
      const workflow = parseYaml(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
      const screens = workflow.jobs['ui-screens'].steps.map(step => step.run ?? '').find(text => text.startsWith('npm run test:screens --'));
      const runner = screens.slice(0, screens.indexOf(' -- ') + 4);
      await check('dashboard screens', 'ui-screens: shell, setup and auth-setup screens', `npm run build:specimen --prefix packages/myco-server/ui && ${screens}`, async () => {
        const env = { ...sandbox, PLAYWRIGHT_BROWSERS_PATH: browsers };
        await run(npm, ['run', 'build:specimen', '--prefix', 'packages/myco-server/ui'], { cwd: copy, env });
        // CI's two workers. A screens file that fails runs again by itself, one file at a time, as test files do.
        const first = await run(`${screens} --workers=2`, [], { cwd: copy, env, shell: true }).then(() => null, error => {
          if (error instanceof Stop) throw error;
          return error.message;
        });
        if (first === null) return;
        const failing = [...new Set([...first.matchAll(/✘.*?([\w.-]+\.screens\.ts)/g)].map(match => match[1]))];
        if (!failing.length) throw new Error(tail(first, 80));
        const { confirmed, passedOnRerun: passedAlone } = await retryAlone({ failing, runAlone: file =>
          run(`${runner}${file} --workers=2`, [], { cwd: copy, env, shell: true }).then(() => true, error => { if (error instanceof Stop) throw error; return false; }) });
        passedOnRerun.push(...passedAlone.map(file => `tests/ui-screens/${file}`));
        if (confirmed.length) throw new Error(`Failing again by itself: ${confirmed.join(', ')}\n${tail(first, 80)}`);
      });
    }
  })();
  const typesLane = (async () => {
    await check('skill content (strict)', 'lint: lint:skills:strict', 'Fix the reported skill content; npm run lint:skills:strict',
      () => run(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/lint-skill-content.ts', '--strict']));
    await check('product types', 'lint: tsc --noEmit', 'Fix the reported product type errors; npx tsc --noEmit',
      () => run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']));
    await check('test types', 'lint: typecheck:tests', 'Fix the reported test type errors; npm run typecheck:tests',
      () => run(npm, ['run', 'typecheck:tests']));
    await check('worker types', 'lint: check:workers', 'Fix the reported server type errors; npm run check:workers',
      () => run(npm, ['run', 'check:workers']));
    await check('dashboard types', 'lint: check:ui', 'Fix the reported dashboard type errors; npm run check:ui -w @goondocks/myco-server',
      () => run(npm, ['run', 'check:ui', '-w', '@goondocks/myco-server']));
  })();
  lanes.push(testsLane, buildLane, typesLane, parityLane);
  const rejected = await settleLanes(lanes, cancelAll);
  if (rejected.length) throw rejected[0];

  // After the shards: the shard audit reads the runner's plan, and timing is measured on a quieter machine.
  await check('test shards', 'lint: check-test-shards', 'Fix the shard plan or durations; node scripts/check-test-shards.mjs',
    () => run(process.execPath, ['scripts/run-test-command.mjs', process.execPath, 'scripts/check-test-shards.mjs']));
  if (compiled && binary && fs.existsSync(binary)) {
    const testWith = (file, variable, name, ci) => check(name, ci, `${variable}=<binary> npm test -- ${file}`, async () => {
      const once = () => run(process.execPath, ['scripts/run-bun-tests.mjs', file], { env: runnerEnv({ [variable]: binary,
        MYCO_RUNNER_REPORT_DIR: path.join(checkRoot, path.basename(file, '.test.ts')) }) });
      try {
        await againIfFailed(`${name}: ${file}`, once);
      } catch (error) {
        if (error instanceof Stop) throw error;
        const { lines } = runnerFailures(error.output ?? '');
        throw new Error(lines.length ? lines.join('\n') : tail(error.message));
      }
    });
    if (wants('compiled-sign-in')) {
      await testWith('tests/cli/login-exit.test.ts', 'MYCO_LOGIN_TEST_BINARY', 'compiled sign-in', 'hook startup (linux-x64, linux-arm64): Check compiled sign-in exits');
    }
    if (wants('compiled-routing')) {
      await testWith('tests/member/rbac-routing-smoke.test.ts', 'MYCO_RBAC_SMOKE_BINARY', 'compiled repository routing', 'build: One machine routes each repository to its explicit Deployment');
    }
    if (wants('hook-startup')) {
      const workflow = parseYaml(fs.readFileSync('.github/workflows/ci.yml', 'utf8'));
      const leg = workflow.jobs['hook-startup'].strategy.matrix.include.find(one => one.target === host.name);
      if (!leg?.ceiling) notRun.push({ what: 'compiled hook startup', why: `left to CI: the workflow measures no ${host.name} leg here` });
      else {
        await check(`no-op hook within ${leg.ceiling} ms`, `hook startup (${host.name}): Measure a no-op hook`,
          `node packages/myco/scripts/measure-hook-startup.mjs <binary> --max-p95-ms ${leg.ceiling}`,
          () => againIfFailed(`no-op hook within ${leg.ceiling} ms`,
            () => run(process.execPath, ['packages/myco/scripts/measure-hook-startup.mjs', binary, '--max-p95-ms', String(leg.ceiling)])));
        await check('every hook at work', `hook startup (${host.name}): Measure every hook at work`,
          'bun packages/myco/scripts/measure-hook-work.ts <binary>',
          () => againIfFailed('every hook at work', () => run('bun', ['packages/myco/scripts/measure-hook-work.ts', binary, '--scratch-root', scratch])));
      }
    }
  }
} catch (error) {
  failed++;
  if (error instanceof Stop) console.error(`STOPPED: ${error.message}`);
  else console.error(`FAIL check:pr itself: ${error.stack ?? error.message}\nIf origin/main is missing: git fetch origin main, then npm run check:pr`);
} finally {
  // Nothing may still be running, or still printing, when the scratch directory goes and the counts are written.
  if (lanes.length) await settleLanes(lanes, cancelAll);
  while (children.size) await new Promise(resolve => setTimeout(resolve, 50));
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(summaryLine({ passed, failed, seconds: Math.ceil((performance.now() - started) / 1000), base, notRun, passedOnRerun }));
process.exitCode = failed ? 1 : 0;
