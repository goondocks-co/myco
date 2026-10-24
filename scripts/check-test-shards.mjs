import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parse } from 'yaml';
import { PARITY_PLAN_PREFIX } from './test-shards.mjs';
import { assertNodeShardHeadroom, assertTestCaseHeadroom, declaredTestTimeout, testDurationSamples } from './node-test-durations.mjs';

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
    const files = new Set(samples.flatMap(run => run.tests.map(test => test.file)));
    samples = fs.readdirSync(reports, { recursive: true }).filter(file => file.endsWith('.junit.xml')).map(file => ({
      source: path.join(reports, file),
      tests: testDurationSamples(fs.readFileSync(path.join(reports, file), 'utf8')).filter(test => files.has(test.file)),
    }));
    assert.ok(samples.length, 'Per-test headroom needs JUnit reports');
  }
  assertTestCaseHeadroom(samples, test => declaredTestTimeout(root, test));
  console.log(`Per-test headroom: ${samples.reduce((sum, run) => sum + run.tests.length, 0)} recorded cases within limit`);
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
  if (mode === '--finish') {
    milliseconds = Date.now() - JSON.parse(fs.readFileSync(stamp, 'utf8')).started;
    fs.unlinkSync(stamp);
  } else {
    assert.equal(separator, '--', 'Measurement command requires --');
    assert.ok(command.length, 'Measurement command is required');
    const started = performance.now();
    const result = spawnSync(command[0], command.slice(1), { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
    milliseconds = performance.now() - started;
  }
  fs.writeFileSync(path.join(timingRoot, `${job}.json`), JSON.stringify({ job, milliseconds }) + '\n');
  console.log(`${job}: measured ${Math.ceil(milliseconds)}ms`);
  assertJobHeadroom(job, workflow.jobs[job]['timeout-minutes'], milliseconds);
}

function audit() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-shard-audit-'));
  const manifestPath = path.join(scratch, 'manifest.json');
  const baseEnv = { ...process.env };
  for (const key of ['MYCO_TEST_KIND', 'MYCO_TEST_SHARD', 'MYCO_TEST_PROFILE', 'MYCO_PARITY_SHARD']) delete baseEnv[key];
  baseEnv.MYCO_RUNNER_REPORT_DIR = path.join(scratch, 'reports');

  function manifest(command, env, outputPrefix) {
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
      MYCO_RUNNER_DRY_RUN: '1', MYCO_RUNNER_PLAN_FILE: manifestPath, ...env,
    });
  }

  function parityPlan(env = {}) {
    return manifest(['node', 'scripts/run-bun-tests.mjs', 'tests/parity/parity.test.ts'], {
      MYCO_PARITY: '1', MYCO_PARITY_PLAN: '1', ...env,
    }, PARITY_PLAN_PREFIX);
  }

  function exactlyOnce(actual, expected, label) {
    assert.equal(new Set(actual).size, actual.length, `${label}: duplicate coverage`);
    assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: missing or unexpected coverage`);
    console.log(`${label}: ${actual.length} entries covered exactly once`);
  }

  try {
    const full = testPlan();
    const discovered = fs.readdirSync(path.join(root, 'tests'), { recursive: true })
      .filter((file) => /\.test\.tsx?$/.test(file)).map((file) => `tests/${file.split(path.sep).join('/')}`);
    exactlyOnce(full.flatMap((phase) => phase.files), discovered, 'Full suite');
    const nodePlans = [];
    const sharded = workflow.jobs.tests.strategy.matrix.include.flatMap(({ kind, shard }) => {
      const plan = testPlan({ MYCO_TEST_KIND: kind, MYCO_TEST_SHARD: shard });
      if (kind === 'node') nodePlans.push(plan);
      console.log(`${kind} ${shard}: estimated ${Math.round(plan.reduce((sum, phase) => sum + phase.estimatedMs, 0) / 1000)}s`);
      return plan;
    });
    exactlyOnce(sharded.flatMap((phase) => phase.files), discovered, 'CI test shards');
    const durations = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-durations.json'), 'utf8'));
    auditJobHeadroom(workflow, durations.jobs);
    const nodeWorkload = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/runner/node-ci-durations.json'), 'utf8'));
    auditTestHeadroom();
    assertNodeShardHeadroom(nodePlans, workflow.jobs.tests['timeout-minutes'] * 60_000, durations.files, nodeWorkload);
    const fullPhases = full.filter((phase) => !phase.label.endsWith('.tsx'));
    const shardPhases = sharded.filter((phase) => !phase.label.endsWith('.tsx'));
    assert.deepEqual(shardPhases.sort((a, b) => a.label.localeCompare(b.label)), fullPhases.sort((a, b) => a.label.localeCompare(b.label)), 'Node phase isolation changed');
    const parityShards = workflow.jobs.parity.strategy.matrix.shard;
    const parityScenarios = parityPlan();
    const parityWeights = JSON.parse(fs.readFileSync(path.join(root, 'scripts/test-durations.json'), 'utf8')).parity;
    for (const name of parityScenarios) {
      assert.ok(Number.isFinite(parityWeights[name]) && parityWeights[name] > 0, `Parity scenario needs an explicit duration weight: ${name}`);
    }
    exactlyOnce(parityShards.flatMap((index) => parityPlan({
      MYCO_PARITY_SHARD: workflow.jobs.parity.env.MYCO_PARITY_SHARD.replace('${{ matrix.shard }}', String(index)),
    })), parityScenarios, 'CI parity shards');
    exactlyOnce(workflow.jobs.check.needs, Object.keys(workflow.jobs).filter((job) => job !== 'check'), 'Required jobs');
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
