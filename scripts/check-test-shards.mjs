import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from 'yaml';
import { PARITY_PLAN_PREFIX } from './test-shards.mjs';
import { assertNodeShardBudgets, assertNodeShardWeights, assertTestCaseHeadroom, declaredTestTimeout, testCaseHeadroomBreaches, testDurationSamples } from './node-test-durations.mjs';
import { BUILD_JOB_FILES, HEAVY_AND_SCALE_SUITES, PARITY_SMOKE_SCENARIOS } from './ci-scopes.mjs';
import { reportTimingBreach, testHeadroomReports, timingGateReports } from './timing-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
const MAX_TEST_JOB_SHARE = 1 / 2;

export function assertJobHeadroom(job, timeoutMinutes, milliseconds, policy) {
  const timeoutMs = timeoutMinutes * 60_000;
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${job}: invalid timeout`);
  assert.ok(Number.isFinite(milliseconds) && milliseconds > 0, `${job}: missing positive measured duration`);
  assert.ok(milliseconds <= timeoutMs * MAX_TEST_JOB_SHARE, `${job}: measured ${Math.ceil(milliseconds)}ms exceeds ${MAX_TEST_JOB_SHARE * 100}% of timeout ${timeoutMs}ms`);
  if (!policy) return;
  assert.ok(Number.isFinite(policy.cacheMissMs) && policy.cacheMissMs >= 0 && Number.isFinite(policy.setupMs) && policy.setupMs >= 0, `${job}: invalid setup allowance`);
  assert.ok(2 * milliseconds + policy.cacheMissMs + policy.setupMs <= timeoutMs, `${job}: timeout must cover twice measured work plus cache-miss install and setup`);
}

export function auditJobHeadroom(workflow, jobs) {
  for (const job of ['ui-screens', 'hook-startup']) {
    const policy = jobs[job];
    assert.ok(policy?.source, `${job}: measured duration needs a source`);
    const commands = workflow.jobs[job].steps.map(step => step.run ?? '');
    assert.ok(commands.some(command => command.includes(`--measure ${job} --`)) || (
      commands.some(command => command === `node scripts/check-test-shards.mjs --start ${job}`) &&
      commands.some(command => command === `node scripts/check-test-shards.mjs --finish ${job}`)
    ), `${job}: missing live headroom measurement`);
    assertJobHeadroom(job, workflow.jobs[job]['timeout-minutes'], policy.measuredMs, policy);
  }
  assert.ok(workflow.jobs.tests.steps.some(step =>
    step.run === 'node scripts/check-test-shards.mjs --test-reports target/test-reports' &&
    step.if === "always() && matrix.kind == 'node'"
  ), 'tests: missing always() live per-test timeout headroom gate');
  console.log('Job headroom: 2 jobs within limit');
}

function auditTestHeadroom(reports) {
  const workload = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/runner/node-ci-durations.json'), 'utf8'));
  assert.ok(workload.testRuns?.length, 'Per-test headroom needs recorded CI test samples');
  let samples = workload.testRuns;
  if (reports) {
    samples = fs.readdirSync(reports, { recursive: true }).filter(file => file.endsWith('.junit.xml')).map(file => {
      const source = path.join(reports, file);
      const tests = testDurationSamples(fs.readFileSync(source, 'utf8'));
      const bundles = tests.some(test => test.file.startsWith('target/test-bundles/'))
        ? JSON.parse(fs.readFileSync(path.join(path.dirname(source), 'bundle-sources.json'), 'utf8')) : {};
      return { source, tests: tests.map(test => ({ ...test, sourceFiles: bundles[test.file] })) };
    });
  }
  const timeoutFor = test => declaredTestTimeout(root, test);
  const recordedCases = samples.reduce((sum, run) => sum + run.tests.length, 0);
  if (testHeadroomReports()) {
    const breaches = testCaseHeadroomBreaches(samples, timeoutFor);
    breaches.forEach(breach => reportTimingBreach(breach));
    console.log(`Per-test headroom: ${recordedCases - breaches.length} of ${recordedCases} recorded cases within limit`);
    return;
  }
  assertTestCaseHeadroom(samples, timeoutFor);
  console.log(`Per-test headroom: ${recordedCases} recorded cases within limit`);
}

function measure(args) {
  const [mode, job, separator, ...command] = args;
  const durations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-durations.json'), 'utf8'));
  const policy = durations.jobs[job];
  assert.ok(policy && workflow.jobs[job], `Unknown measured job: ${job}`);
  const timingRoot = path.join(process.env.MYCO_RUNNER_REPORT_DIR ?? path.join(root, 'target'), 'ci-timings');
  fs.mkdirSync(timingRoot, { recursive: true });
  const stamp = path.join(timingRoot, `${job}-start.json`);
  if (mode === '--start') {
    fs.writeFileSync(stamp, JSON.stringify({ started: Date.now() }));
    return;
  }
  let milliseconds;
  let exitCode = 0;
  if (mode === '--finish') {
    milliseconds = Date.now() - JSON.parse(fs.readFileSync(stamp, 'utf8')).started;
    fs.unlinkSync(stamp);
  } else {
    assert.equal(separator, '--', 'Measurement command requires --');
    assert.ok(command.length, 'Measurement command is required');
    const started = performance.now();
    const result = spawnSync(command[0], command.slice(1), { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
    milliseconds = performance.now() - started;
  }
  fs.writeFileSync(path.join(timingRoot, `${job}.json`), JSON.stringify({ job, milliseconds, exitCode }) + '\n');
  console.log(`${job}: measured ${Math.ceil(milliseconds)}ms`);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    return;
  }
  reportingTimingBreach(() => assertJobHeadroom(job, workflow.jobs[job]['timeout-minutes'], milliseconds));
}

// Run a timing assertion; on a run that reports timing, a breach warns instead of failing.
function reportingTimingBreach(check) {
  try {
    check();
  } catch (error) {
    if (!timingGateReports() || !(error instanceof assert.AssertionError)) throw error;
    reportTimingBreach(error.message);
  }
}

export function assertCoverage(actual, expected, label) {
    assert.equal(new Set(actual).size, actual.length, `${label}: duplicate coverage`);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: missing or unexpected coverage`);
    console.log(`${label}: ${actual.length} entries covered exactly once`);
}


/** Shard and plan selectors a nested runner must not inherit from its parent. */
export const nestedRunnerEnvKeys = ['MYCO_TEST_SCOPE', 'MYCO_TEST_KIND', 'MYCO_TEST_SHARD', 'MYCO_TEST_GROUP', 'MYCO_TEST_PROFILE', 'MYCO_PARITY_SHARD', 'MYCO_RUNNER_PLAN_FILE', 'MYCO_RUNNER_MATRIX_PLAN_FILE', 'MYCO_PARITY_PLAN_MATRIX'];

function audit() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-shard-audit-'));
  const manifestPath = path.join(scratch, 'manifest.json');
  const baseEnv = { ...process.env };
  for (const key of nestedRunnerEnvKeys) delete baseEnv[key];
  baseEnv.MYCO_RUNNER_REPORT_DIR = path.join(scratch, 'reports');

  let generations = 0;
  function manifest(command, env, outputPrefix) {
    generations++;
    fs.rmSync(manifestPath, { force: true });
    const result = spawnSync(command[0], command.slice(1), {
      cwd: root, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(result.status, 0, `${command.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    if (outputPrefix) {
      const line = result.stdout.split('\n').find((line) => line.startsWith(outputPrefix));
      assert.ok(line, `Missing shard manifest from ${command.join(' ')}`);
      return JSON.parse(line.slice(outputPrefix.length));
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  function testPlan(env = {}) {
    return manifest(['node', 'scripts/run-bun-tests.mjs'], {
      MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_MATRIX_PLAN_FILE: manifestPath, ...env,
    });
  }

  function parityPlan(env = {}) {
    return manifest(['node', 'scripts/run-bun-tests.mjs', 'tests/parity/parity.test.ts'], {
      MYCO_PARITY: '1', MYCO_PARITY_PLAN: '1', ...env,
    }, PARITY_PLAN_PREFIX);
  }


  try {
    const matrix = testPlan({ MYCO_TEST_SCOPE: 'full' });
    const full = matrix.full;
    const discovered = fs.readdirSync(path.join(root, 'tests'), { recursive: true })
      .filter((file) => /\.test\.tsx?$/.test(file)).map((file) => `tests/${file.split(path.sep).join('/')}`);
    for (const file of [...BUILD_JOB_FILES, ...HEAVY_AND_SCALE_SUITES]) assert.ok(discovered.includes(file), `Listed in scripts/ci-scopes.mjs but no such test: ${file}`);
    const shardFiles = discovered.filter((file) => !BUILD_JOB_FILES.includes(file));
    assert.ok(BUILD_JOB_FILES.every((file) => workflow.jobs.build.steps.some((step) => step.run === `npm test -- ${file}`)), 'A file listed for the build job is not run by it');
    assertCoverage(full.flatMap((phase) => phase.files), shardFiles, 'Full suite');
    const nodePlans = [];
    assert.deepEqual(matrix.ordinary.map(({ kind, shard }) => ({ kind, shard })), workflow.jobs.tests.strategy.matrix.include, 'Runner matrix differs from CI');
    const ordinary = matrix.ordinary.flatMap(({ kind, shard, phases: plan }) => {
      if (kind === 'node') nodePlans.push(plan);
      console.log(`${kind} ${shard}: estimated ${Math.round(plan.reduce((sum, phase) => sum + phase.estimatedMs, 0) / 1000)}s`);
      return plan;
    });
    const sharded = ordinary;
    assertCoverage(sharded.flatMap((phase) => phase.files), shardFiles, 'CI test shards (full run)');
    const pullRequest = testPlan({ MYCO_TEST_SCOPE: 'pr' }).ordinary.flatMap(({ phases: plan }) => plan);
    assertCoverage(pullRequest.flatMap((phase) => phase.files), shardFiles.filter((file) => !HEAVY_AND_SCALE_SUITES.includes(file)), 'CI test shards (pull request)');
    const durations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-durations.json'), 'utf8'));
    auditJobHeadroom(workflow, durations.jobs);
    const nodeWorkload = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/runner/node-ci-durations.json'), 'utf8'));
    auditTestHeadroom();
    assertNodeShardWeights(nodePlans, durations.files, nodeWorkload);
    reportingTimingBreach(() => assertNodeShardBudgets(nodePlans, workflow.jobs.tests['timeout-minutes'] * 60_000, durations.files, nodeWorkload));
    const fullPhases = full.filter((phase) => !phase.label.endsWith('.tsx'));
    const shardPhases = sharded.filter((phase) => !phase.label.endsWith('.tsx'));
    assert.deepEqual(shardPhases.sort((a, b) => a.label.localeCompare(b.label)), fullPhases.sort((a, b) => a.label.localeCompare(b.label)), 'Node phase isolation changed');
    const parityShards = workflow.jobs.parity.strategy.matrix.shard;
    const selectors = parityShards.map(index => workflow.jobs.parity.env.MYCO_PARITY_SHARD.replace('${{ matrix.shard }}', String(index)));
    const parity = parityPlan({ MYCO_PARITY_PLAN_MATRIX: JSON.stringify(selectors) });
    const parityScenarios = parity.full;
    const parityWeights = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-durations.json'), 'utf8')).parity;
    for (const name of parityScenarios) {
      assert.ok(Number.isFinite(parityWeights[name]) && parityWeights[name] > 0, `Parity scenario needs an explicit duration weight: ${name}`);
    }
    assert.deepEqual(parity.shards.map(({ shard }) => shard), selectors, 'Parity matrix differs from CI');
    assertCoverage(parity.shards.flatMap(({ scenarios }) => scenarios), parityScenarios, 'CI parity shards');
    for (const name of PARITY_SMOKE_SCENARIOS) assert.ok(parityScenarios.includes(name), `Parity smoke names a scenario that does not exist: ${name}`);
    const windowsTests = job => job.steps.flatMap(step => /npm test --/.test(step.run ?? '') ? step.run.split(/\s+/).filter(word => word.startsWith('tests/')) : []);
    const windowsSmoke = windowsTests({ steps: workflow.jobs['windows-native'].steps.filter(step => step.if === "env.MYCO_TEST_SCOPE != 'full'") });
    const windowsFull = windowsTests({ steps: workflow.jobs['windows-native'].steps.filter(step => step.if === "env.MYCO_TEST_SCOPE == 'full'") });
    assert.ok(windowsSmoke.length > 0 && windowsSmoke.every(file => windowsFull.includes(file)), 'Windows smoke must be a non-empty subset of the full Windows list');
    assert.equal(generations, 3, 'Shard auditing must generate each runner plan once');
    console.log(`Plan generations: ${generations}`);
    assertCoverage(workflow.jobs.check.needs, Object.keys(workflow.jobs).filter((job) => job !== 'check'), 'Required jobs');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (['--measure', '--start', '--finish'].includes(process.argv[2])) measure(process.argv.slice(2));
  else if (process.argv[2] === '--test-headroom') auditTestHeadroom();
  else if (process.argv[2] === '--test-reports') {
    assert.ok(process.argv[3], '--test-reports requires a report directory');
    auditTestHeadroom(process.argv[3]);
  } else audit();
}
