import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PARITY_PLAN_PREFIX } from './test-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
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
  const sharded = workflow.jobs.tests.strategy.matrix.include.flatMap(({ kind, shard }) => {
    const plan = testPlan({ MYCO_TEST_KIND: kind, MYCO_TEST_SHARD: shard });
    console.log(`${kind} ${shard}: estimated ${Math.round(plan.reduce((sum, phase) => sum + phase.estimatedMs, 0) / 1000)}s`);
    return plan;
  });
  exactlyOnce(sharded.flatMap((phase) => phase.files), discovered, 'CI test shards');
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
