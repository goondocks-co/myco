#!/usr/bin/env node
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { BUILD_JOB_FILES, HEAVY_AND_SCALE_SUITES } from './ci-scopes.mjs';
import { staleReason } from './ensure-deps.mjs';
import { affectedTests } from './pr-test-selection.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const started = performance.now();
const execBuffered = promisify(execFile);
const activeTests = new Set();
let interrupted;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  interrupted = signal;
  for (const child of activeTests) {
    if (!child.pid) continue;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
});
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const FULL_JOB_TESTS = new Set([...HEAVY_AND_SCALE_SUITES, ...BUILD_JOB_FILES, 'tests/parity/parity.test.ts']);
const CARRIER = 'packages/myco/src/server-ui-assets.generated.ts';
const BUNDLE_STEP = 'The standalone dashboard matches its committed bundle without shared build artifacts';
const bundleFix = 'npm run build:ui -w @goondocks/myco-server\nnpx tsx packages/myco/scripts/gen-ui-assets.ts\ngit add packages/myco/src/server-ui-assets.generated.ts\ngit commit';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
let passed = 0;
let failed = 0;
let affectedSkipped = 0;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

class Stop extends Error {}
const STOP_SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
// npm reports a child stopped by a signal as exit 128 + the signal number.
const STOP_STATUSES = new Map([[129, 'SIGHUP'], [130, 'SIGINT'], [143, 'SIGTERM']]);

function command(tool, args, cwd = root) {
  const result = spawnSync(tool, args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
  if (STOP_SIGNALS.has(result.signal) || STOP_STATUSES.has(result.status)) interrupted ??= result.signal ?? STOP_STATUSES.get(result.status);
  if (interrupted) throw new Stop(`Interrupted by ${interrupted}`);
  if (result.error || result.status !== 0) {
    throw new Error(`${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}\nExit: ${result.status ?? result.signal}`);
  }
}

function reportCheck({ name, ci, fix, start, error, output = '' }) {
  if (!error && output.trim()) console.log(`${name} output:\n${output.trimEnd()}`);
  if (error) failed++; else passed++;
  console.log(`${error ? 'FAIL' : 'PASS'} ${name} (${((performance.now() - start) / 1000).toFixed(1)} s)`);
  if (error) console.error(`CI step: ${ci}\n${error.message}\nFix:\n${fix}`);
}

function check(name, ci, fix, run) {
  const start = performance.now();
  let error;
  if (interrupted) throw new Stop(`Interrupted by ${interrupted}`);
  try { run(); } catch (caught) {
    if (caught instanceof Stop) throw caught;
    error = caught;
  }
  reportCheck({ name, ci, fix, start, error });
}

async function checkTests(name, ci, fix, files) {
  const start = performance.now();
  if (!files.length) {
    reportCheck({ name, ci, fix, start, error: new Error('No test files selected; refusing an unfiltered test run.') });
    return;
  }
  const task = execBuffered(npm, ['test', '--', ...files], {
    cwd: root, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, detached: process.platform !== 'win32',
  });
  activeTests.add(task.child);
  let error;
  let output;
  try {
    const result = await task;
    output = result.stdout + result.stderr;
  } catch (caught) {
    error = new Error(`${caught.stdout ?? ''}${caught.stderr ?? ''}\nExit: ${caught.code ?? caught.signal ?? caught.message}`);
    if (caught.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && task.child.pid && process.platform !== 'win32') {
      try { process.kill(-task.child.pid, 'SIGTERM'); } catch (stopError) { if (stopError.code !== 'ESRCH') throw stopError; }
    }
  } finally { activeTests.delete(task.child); }
  reportCheck({ name, ci, fix, start, error, output });
}

function dashboard() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-check-pr-'));
  try {
    // Only versioned and unignored inputs enter the copy; shared dist is absent as in CI.
    const inputs = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
      'package.json', 'package-lock.json', 'tsconfig.json', 'scripts/ensure-deps.mjs',
      'packages/myco-server', 'packages/myco-shared', 'packages/myco/package.json',
      'packages/myco/scripts/gen-ui-assets.ts']).split('\0').filter(Boolean);
    for (const file of new Set(inputs)) {
      if (!fs.existsSync(file)) continue;
      const destination = path.join(scratch, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }
    const modules = path.join(scratch, 'node_modules');
    fs.mkdirSync(path.join(modules, '@goondocks'), { recursive: true });
    for (const entry of fs.readdirSync('node_modules', { withFileTypes: true })) {
      if (entry.name === '@goondocks') continue;
      const source = path.join(root, 'node_modules', entry.name);
      const destination = path.join(modules, entry.name);
      if (entry.isDirectory()) fs.symlinkSync(source, destination, 'junction');
      else fs.copyFileSync(source, destination);
    }
    // Workspace imports resolve inside the copy, including the absent shared build.
    for (const name of ['myco', 'myco-server', 'myco-shared']) {
      fs.symlinkSync(path.join(scratch, 'packages', name), path.join(modules, '@goondocks', name), 'junction');
    }
    fs.symlinkSync(path.join(root, 'packages/myco-server/ui/node_modules'),
      path.join(scratch, 'packages/myco-server/ui/node_modules'), 'junction');
    fs.mkdirSync(path.join(scratch, 'packages/myco/src'), { recursive: true });
    command(npm, ['run', 'build:ui', '-w', '@goondocks/myco-server'], scratch);
    command(npx, ['tsx', 'packages/myco/scripts/gen-ui-assets.ts'], scratch);
    const committed = execFileSync('git', ['show', `HEAD:${CARRIER}`], { maxBuffer: MAX_OUTPUT_BYTES });
    if (!committed.equals(fs.readFileSync(path.join(scratch, CARRIER)))) {
      throw new Error(`${CARRIER} differs from the rebuilt dashboard at HEAD. Regenerate and commit it.`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

let base = 'unknown';
try {
  base = git(['merge-base', 'origin/main', 'HEAD']).trim();
  const changed = [...new Set([
    ...git(['diff', '--name-only', '-z', '--no-renames', base]).split('\0'),
    ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ].filter(Boolean))].sort();
  if (git(['status', '--porcelain']).trim()) {
    console.warn('WARNING: dirty tree: check:test-budget reads HEAD for the line ratio. Commit your changes and rerun check:pr before pushing.');
  }
  const stale = [['workspace', root], ['dashboard', path.join(root, 'packages/myco-server/ui')]]
    .map(([label, directory]) => [label, staleReason(directory)]).filter(([, reason]) => reason);
  check('workspace dependencies', 'CI setup: install dependencies', 'node scripts/ensure-deps.mjs', () => {
    if (stale.length) throw new Error(`${stale.map(([label, reason]) => `${label} ${reason}`).join('; ')}; checks require dependencies from the lockfiles.`);
  });
  if (stale.length) throw new Stop('dependencies are stale; install them and rerun');
  const behind = git(['rev-list', '--count', `${base}..origin/main`]).trim();
  if (behind !== '0') console.warn(`WARNING: branch is ${behind} commits behind origin/main; CI tests the merge with current main. git fetch origin && git rebase origin/main`);
  check('bun version', 'CI setup: oven-sh/setup-bun with .bun-version',
    'Put the pinned Bun first on PATH (the version in .bun-version), then npm run check:pr', () => {
      const pinned = fs.readFileSync('.bun-version', 'utf8').trim();
      const found = spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim();
      if (found !== pinned) throw new Error(`bun ${found || 'not found'} is on PATH but CI runs ${pinned}; test results would differ from CI.`);
    });
  const gate = (name, script, ci, fix) => check(name, ci, fix,
    () => command(process.execPath, [`scripts/${script}.mjs`, base]));
  gate('shipped migrations', 'check-shipped-migrations', 'Shipped migrations are unchanged and new ones append',
    'Restore shipped migrations; add a new schema step, then npm run migrations:emit -w @goondocks/myco-server');
  gate('test additions', 'check-test-additions', 'Added test lines assert behaviour, not code',
    'Replace the reported added test statements with assertions of observable behaviour; npm run check:test-additions');
  gate('test budget', 'check-test-budget', 'Test runner time and test-to-product ratio stay inside their budget',
    'Delete or demote redundant/heavy tests, commit, then npm run check:test-budget');
  check('server gates', 'tests (node): tests/myco-server/gates.test.ts',
    'Reconcile runtime dependency pins and the server contract; npm test -- tests/myco-server/gates.test.ts',
    () => command(npm, ['test', '--', 'tests/myco-server/gates.test.ts']));

  if (changed.some(file => /^packages\/(?:myco-server|myco-shared)\//.test(file)
    || file === CARRIER || /(?:^|\/)(?:package\.json|npm-shrinkwrap\.json|package-lock\.json)$/.test(file)
    || file === 'tsconfig.json' || file === 'packages/myco/scripts/gen-ui-assets.ts')) {
    check('dashboard bundle', BUNDLE_STEP, bundleFix, dashboard);
  }
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'packages', 'tests', 'scripts']).split('\0').filter(Boolean);
  const candidates = affectedTests({ root, files: [...new Set(files)], changed })
    .filter(({ file }) => (!file.startsWith('tests/meta/') || FULL_JOB_TESTS.has(file))
      && file !== 'tests/myco-server/gates.test.ts');
  // Changed test files always run. Importers are too broad to run locally (a shared module reaches hundreds of
  // files), so they are listed with their command; CI runs them.
  const selected = candidates.filter(({ file, tier }) => tier === 0 && !FULL_JOB_TESTS.has(file)).map(({ file }) => file);
  const importers = candidates.filter(({ file, tier }) => tier > 0 || FULL_JOB_TESTS.has(file)).map(({ file }) => file).sort();
  affectedSkipped = importers.length;
  console.log(`Changed tests: ${selected.length} run (${selected.join(', ') || 'none'}); importing tests not run: ${importers.length}`);
  if (importers.length) {
    console.warn(`Run importing tests: npm test -- ${importers.map(quote).join(' ')}`);
    if (importers.includes('tests/parity/parity.test.ts')) console.warn('For parity: npm run test:parity');
  }
  if (interrupted) throw new Stop(`Interrupted by ${interrupted}`);
  const testChecks = [];
  if (changed.length > 0) {
    const meta = fs.readdirSync('tests/meta', { recursive: true })
      .map(file => `tests/meta/${file}`.replaceAll('\\', '/'))
      .filter(file => /\.test\.tsx?$/.test(file) && !FULL_JOB_TESTS.has(file));
    testChecks.push(checkTests('meta tests (PR scope)', 'tests (node): tests/meta in the PR scope',
      'Fix the reported boundary; npm test -- tests/meta', meta));
  }
  if (selected.length) testChecks.push(checkTests('changed tests', 'tests (node/DOM)',
    `Fix the reported test failures; npm test -- ${selected.map(quote).join(' ')}`, selected));
  await Promise.all(testChecks);
  if (interrupted) throw new Stop(`Interrupted by ${interrupted}`);

  check('skill content (strict)', 'lint: lint:skills:strict', 'Fix the reported skill content; npm run lint:skills:strict',
    () => command(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/lint-skill-content.ts', '--strict']));
  check('test shards', 'lint: check-test-shards', 'Fix the shard plan or durations; node scripts/check-test-shards.mjs',
    () => command(process.execPath, ['scripts/run-test-command.mjs', process.execPath, 'scripts/check-test-shards.mjs']));

  check('worker bundle preparation', 'lint (prelint)', 'npx tsx packages/myco/scripts/gen-worker-bundle.ts',
    () => command(process.execPath, ['--import', 'tsx', 'packages/myco/scripts/gen-worker-bundle.ts']));
  check('product types', 'lint: tsc --noEmit', 'Fix the reported product type errors; npx tsc --noEmit',
    () => command(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']));
  check('test types', 'lint: typecheck:tests', 'Fix the reported test type errors; npm run typecheck:tests',
    () => command(npm, ['run', 'typecheck:tests']));
  check('worker types', 'lint: check:workers', 'Fix the reported server type errors; npm run check:workers',
    () => command(npm, ['run', 'check:workers']));
  check('dashboard types', 'lint: check:ui', 'Fix the reported dashboard type errors; npm run check:ui -w @goondocks/myco-server',
    () => command(npm, ['run', 'check:ui', '-w', '@goondocks/myco-server']));
} catch (error) {
  failed++;
  if (error instanceof Stop) console.error(`STOPPED: ${error.message}`);
  else console.error(`FAIL check:pr itself: ${error.stack ?? error.message}\nIf origin/main is missing: git fetch origin main, then npm run check:pr`);
}
console.log(`check:pr: ${passed} passed, ${failed} failed in ${Math.ceil((performance.now() - started) / 1000)} s (base ${base.slice(0, 9)})${affectedSkipped ? `, ${affectedSkipped} importing test files not run (CI runs them)` : ''}`);
process.exitCode = failed ? 1 : 0;
