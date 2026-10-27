import { describe, expect, test } from 'bun:test';
import { groupByDuration, parseShard, selectGroup, selectShard, VIEW_PROOF_FILES } from '../../scripts/test-shards.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import durations from '../../scripts/test-durations.json';
import parityWorkload from '../fixtures/runner/parity-ci-9777180d.json';
import completeParityWorkload from '../fixtures/runner/parity-ci-f2c7ecc5.json';
import nodeWorkloadFixture from '../fixtures/runner/node-ci-durations.json';
import { mergeNodeDurationWeights, assertTestCaseHeadroom, declaredTestTimeout, testDurationSamples, assertNodeShardHeadroom, nodeDurationSamples, nodeGroupBudget, recordedNodeDurations, type NodeGroup, type NodeWorkload } from '../../scripts/node-test-durations.mjs';

const nodeWorkload: NodeWorkload = nodeWorkloadFixture;

describe('test shard selection', () => {
  test('executes a selected proof file and writes its reports under the run directory', async () => {
    const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proof-execution-'));
    try {
      const file = VIEW_PROOF_FILES[0]!;
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
      const result = await new Promise<{status: number | null; output: string}>((resolve, reject) => {
        const child = spawn('node', ['scripts/run-bun-tests.mjs', file, '-t', '^plan identity excludes'], {
          env: { ...inherited, MYCO_TEST_KIND: 'view-proof', MYCO_TEST_SHARD: '1/1', MYCO_TEST_GROUP: `view proof ${file}`, MYCO_RUNNER_REPORT_DIR: reports },
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({status, output}));
      });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain(`FINISHED view proof ${file}`);
      const files = fs.readdirSync(reports, { recursive: true }).map(String);
      expect(files.filter(name => name.endsWith('.junit.xml'))).toHaveLength(1);
      expect(files.some(name => /view-proof-tests-myco-server-view-read-costs-test-ts\.log$/.test(name))).toBe(true);
    } finally { fs.rmSync(reports, { recursive: true, force: true }); }
  }, 40_000);

  test('owns each view proof once outside node shards and selects each matrix file intact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proof-plan-'));
    const plan = (kind: string, group?: string, targets: string[] = []): NodeGroup[] => {
      const file = path.join(root, 'plan.json');
      const result = spawnSync('node', ['scripts/run-bun-tests.mjs', ...targets], {
        env: { ...process.env, MYCO_RUNNER_DRY_RUN: '1', MYCO_TEST_KIND: kind, MYCO_TEST_SHARD: '1/1',
          ...(group ? { MYCO_TEST_GROUP: group } : {}), MYCO_RUNNER_PLAN_FILE: file, MYCO_RUNNER_REPORT_DIR: path.join(root, 'reports') },
        encoding: 'utf8', timeout: 30_000,
      });
      expect({ status: result.status, error: result.error, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    try {
      const node = plan('node').flatMap(group => group.files);
      expect(node.filter(file => VIEW_PROOF_FILES.includes(file))).toEqual([]);
      expect(plan('view-proof').flatMap(group => group.files).sort()).toEqual([...VIEW_PROOF_FILES].sort());
      for (const file of VIEW_PROOF_FILES) expect(plan('view-proof', `view proof ${file}`).map(group => group.files)).toEqual([[file]]);
      expect(plan('view-proof', undefined, [VIEW_PROOF_FILES[0]!]).map(group => group.files)).toEqual([[VIEW_PROOF_FILES[0]!]]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  test('keeps heavy isolated files apart when small files are inserted before either journey', () => {
    const workflow = parseYaml(fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const budget = nodeGroupBudget(workflow.jobs.tests['timeout-minutes'] * 60_000);
    const files = fs.readdirSync(new URL('../setup/', import.meta.url))
      .filter(file => file.endsWith('.test.ts')).map(file => `tests/setup/${file}`).sort();
    const weights: Record<string, number> = durations.files;
    const weight = (file: string) => weights[file] ?? 1;
    const beforeJourneys = 'tests/setup/journeys-small.test.ts';
    const beforeSigkill = 'tests/setup/sigkill-before.test.ts';
    for (const additions of [[], [beforeJourneys], [beforeSigkill], [beforeJourneys, beforeSigkill]]) {
      const targets = [...files, ...additions].sort();
      const groups = groupByDuration(targets, budget, weight, 3);
      expect(groups.flat()).toEqual(targets);
      expect(groupByDuration(targets, budget, weight, 3)).toEqual(groups);
      for (const group of groups) {
        expect(group.length).toBeLessThanOrEqual(3);
        expect(group.reduce((total, file) => total + weight(file), 0)).toBeLessThanOrEqual(budget);
      }
      const journeys = groups.find(group => group.includes('tests/setup/journeys.test.ts'));
      expect(journeys).not.toContain('tests/setup/sigkill-resume.test.ts');
    }
  });

  test('isolates an oversized file and names it in the headroom refusal', () => {
    const budget = nodeGroupBudget(900_000);
    const weights: Record<string, number> = { small: 1, oversized: budget + 1, exact: budget };
    const targets = ['small', 'oversized', 'small', 'exact', 'small'];
    const groups = groupByDuration(targets, budget, file => weights[file]!);
    expect(groups).toEqual([['small'], ['oversized'], ['small'], ['exact'], ['small']]);
    const oversized = { label: 'oversized group', files: ['oversized'], estimatedMs: weights.oversized! };
    expect(() => assertNodeShardHeadroom([[oversized], [], [], [], []], 900_000, weights, nodeWorkload)).toThrow('split the group: oversized');
    const overJob = { ...oversized, files: ['over-job'], estimatedMs: 900_001 };
    expect(() => assertNodeShardHeadroom([[overJob], [], [], [], []], 900_000, { 'over-job': 900_001 }, nodeWorkload)).toThrow('split the group: over-job');
    expect(groupByDuration([], budget, () => 1)).toEqual([]);
    expect(groupByDuration([1, 2, 3, 4], budget, () => 1, 3)).toEqual([[1, 2, 3], [4]]);
    expect(() => groupByDuration([1], 0, () => 1)).toThrow('budget');
    expect(() => groupByDuration([1], budget, () => NaN)).toThrow('weights');
    expect(() => groupByDuration([1], budget, () => 1, 0)).toThrow('item limit');
  });

  test('retains recorded node process wall time when splitting a file into balancing units', () => {
    for (const [index, sample] of nodeDurationSamples(nodeWorkload).entries()) {
      const elapsed = nodeWorkload.runs[index]!.shards.flatMap(shard => shard.groups).reduce((sum, group) => sum + group.milliseconds, 0);
      expect(Object.values(sample.files).reduce((sum, milliseconds) => sum + milliseconds, 0)).toBeCloseTo(elapsed, 5);
    }
  });

  test('gates node shard headroom against every complete recorded CI workload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-node-shards-'));
    try {
      const manifest = path.join(root, 'plan.json');
      const result = spawnSync('node', ['scripts/run-bun-tests.mjs'], {
        env: { ...process.env, MYCO_RUNNER_DRY_RUN: '1', MYCO_TEST_KIND: 'node', MYCO_TEST_SHARD: '1/1', MYCO_RUNNER_PLAN_FILE: manifest, MYCO_RUNNER_REPORT_DIR: path.join(root, 'reports') },
        encoding: 'utf8', timeout: 30_000,
      });
      expect({ status: result.status, error: result.error, stderr: result.stderr }).toMatchObject({ status: 0, error: undefined });
      const groups: NodeGroup[] = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const workflow = parseYaml(fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
      const count = workflow.jobs.tests.strategy.matrix.include.filter((job: { kind: string }) => job.kind === 'node').length;
      const timeout = workflow.jobs.tests['timeout-minutes'] * 60_000;
      const plans = Array.from({ length: count }, (_, index) => selectShard(groups, { index: index + 1, count }, group => group.estimatedMs));
      expect(() => assertNodeShardHeadroom(plans, timeout, durations.files, nodeWorkload)).not.toThrow();
      const shardOf = (file: string) => plans.findIndex(plan => plan.some(group => group.files.includes(file)));
      const coverageShard = shardOf('tests/myco-server/extraction-coverage-budget.test.ts');
      const steadyShard = shardOf('tests/myco-server/extraction-coverage-steady-state-budget.test.ts');
      expect(coverageShard).toBeGreaterThanOrEqual(0);
      expect(steadyShard).toBeGreaterThanOrEqual(0);
      expect(coverageShard).not.toBe(steadyShard);
      for (const trim of [1, -1]) {
        const incomplete = { runs: nodeWorkload.runs.map(run => ({ ...run, shards: trim === 1 ? run.shards.slice(1) : run.shards.slice(0, -1) })) };
        expect(() => assertNodeShardHeadroom(plans, timeout, durations.files, incomplete)).toThrow('incomplete node workload');
      }
      const stale = { ...durations.files, 'tests/setup/journeys.test.ts': 2920 };
      expect(() => assertNodeShardHeadroom(plans, timeout, stale, nodeWorkload)).toThrow('Stale node duration');
      const unrecorded = { label: 'new file', files: ['tests/unrecorded.test.ts'], estimatedMs: 100 };
      expect(() => assertNodeShardHeadroom([[unrecorded], ...plans.slice(1)], timeout, durations.files, nodeWorkload)).toThrow('explicit duration weight');
      const recorded = recordedNodeDurations(nodeWorkload);
      const journeyFiles = ['tests/setup/journeys.test.ts', 'tests/setup/sigkill-resume.test.ts'];
      const oversized = { label: 'combined journeys', files: journeyFiles, estimatedMs: journeyFiles.reduce((sum, file) => sum + recorded[file]!, 0) };
      expect(() => assertNodeShardHeadroom([[oversized], ...plans.slice(1)], timeout, durations.files, nodeWorkload)).toThrow('split the group');
      expect(() => assertNodeShardHeadroom([groups, ...plans.slice(1).map(() => [])], timeout, durations.files, nodeWorkload)).toThrow('with headroom');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 40_000);

  test('fits the recorded parity workload with startup allowance and headroom on every CI shard', () => {
    const workflow = parseYaml(fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const count = workflow.jobs.parity.strategy.matrix.shard.length;
    const budget = Number(workflow.jobs.parity.env.MYCO_RUNNER_GROUP_BUDGET_MS);
    const weights: Record<string, number> = durations.parity;
    const weight = (scenario: { name: string; milliseconds: number }): number =>
      weights[scenario.name] ?? scenario.milliseconds;
    for (const workload of [parityWorkload, completeParityWorkload]) {
      for (const scenario of workload.scenarios) expect(weight(scenario)).toBeGreaterThan(0);
      const projected = Array.from({ length: count }, (_, index) => {
        const shard = selectShard(workload.scenarios, { index: index + 1, count }, weight);
        return shard.reduce((total, scenario) => total + scenario.milliseconds, workload.sharedTargetAllowanceMs);
      });
      expect(Math.max(...projected), workload.source).toBeLessThanOrEqual(budget - workload.requiredHeadroomMs);
    }
  });
  test('applies the group selector only to the runner that receives it', () => {
    const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-group-selection-'));
    try {
      const result = spawnSync('node', ['scripts/run-bun-tests.mjs', 'tests/fixtures/runner/group_selection_test.ts'], {
        env: { ...process.env, MYCO_TEST_KIND: 'node', MYCO_TEST_SHARD: '1/1', MYCO_TEST_GROUP: 'node env', MYCO_RUNNER_REPORT_DIR: reports },
        encoding: 'utf8', timeout: 30_000,
      });
      expect({ status: result.status, error: result.error }).toEqual({ status: 0, error: undefined });
      expect(result.stdout + result.stderr).toContain('FINISHED node env');
    } finally {
      fs.rmSync(reports, { recursive: true, force: true });
    }
  }, 40_000);
  test('selects an intact group after shard assignment and refuses a group from another shard', () => {
    const groups = [
      { label: 'first', files: ['a', 'b'], weight: 100 },
      { label: 'second', files: ['c'], weight: 50 },
    ];
    const shard = selectShard(groups, parseShard('1/2'), (group) => group.weight);
    expect(selectGroup(shard, 'first')).toEqual([groups[0]]);
    expect(selectGroup(shard, undefined)).toBe(shard);
    expect(() => selectGroup(shard, 'second')).toThrow('not in the selected shard');
    expect(() => selectGroup(shard, 'missing')).toThrow('not in the selected shard');
  });
  test('partitions uneven work exactly once while preserving order and whole groups', () => {
    const groups = [1, 100, 2, 40, 3, 20, 4, 10];
    const partitions = [1, 2, 3].map((index) => selectShard(groups, { index, count: 3 }, (weight) => weight));
    expect(partitions.flat().sort((a, b) => a - b)).toEqual([...groups].sort((a, b) => a - b));
    for (const partition of partitions) expect(partition).toEqual(groups.filter((group) => partition.includes(group)));
    expect(Math.max(...partitions.map((partition) => partition.reduce((sum, weight) => sum + weight, 0)))).toBe(100);
    expect(selectShard(groups, parseShard(undefined))).toEqual(groups);
  });

  test('refuses invalid and empty shards instead of reporting false success', () => {
    for (const value of ['', '0/4', '5/4', '1/0', '1/2x', '1.5/4', '1/257']) {
      expect(() => parseShard(value)).toThrow('Invalid shard');
    }
    expect(() => selectShard(['one'], parseShard('2/2'))).toThrow('contains no tests');
    expect(() => selectShard(['one'], parseShard('1/1'), () => NaN)).toThrow('weights');
  });
});

test('rejects the recorded main lineage case before the parent-column split', () => {
  const baseline = nodeWorkloadFixture.baselineTestRuns;
  expect(() => assertTestCaseHeadroom(baseline, () => baseline[0]!.tests[0]!.timeoutMs)).toThrow('111388.52ms exceeds 80% of its 120000ms test timeout');
});

test('gates recorded per-test CI timings against their own declared timeout', () => {
  const root = path.resolve(import.meta.dir, '../..');
  expect(() => assertTestCaseHeadroom(nodeWorkloadFixture.testRuns, test => declaredTestTimeout(root, test))).not.toThrow();
  const test = nodeWorkloadFixture.testRuns[0]!.tests[2]!;
  const timeoutMs = declaredTestTimeout(root, test);
  expect(timeoutMs).toBe(120_000);
  expect(() => assertTestCaseHeadroom([{ source: 'boundary', tests: [{ ...test, milliseconds: timeoutMs * 0.8 }] }], value => declaredTestTimeout(root, value))).not.toThrow();
  expect(() => assertTestCaseHeadroom([{ source: 'overrun', tests: [{ ...test, milliseconds: timeoutMs * 0.8 + 1 }] }], value => declaredTestTimeout(root, value))).toThrow('80%');
  expect(() => declaredTestTimeout(root, { ...test, name: 'unrecorded test' })).toThrow('matching its recorded name');
});

test('the CI per-test command rejects an overrun from actual JUnit evidence', () => {
  const reports = fs.mkdtempSync(path.join(os.tmpdir(), 'per-test-evidence-'));
  try {
    expect(spawnSync('node', ['scripts/check-test-shards.mjs', '--test-reports'], { encoding: 'utf8' }).status).not.toBe(0);
    const test = nodeWorkloadFixture.testRuns[0]!.tests[2]!;
    const xml = `<testsuite><testcase file="${test.file}" name="${test.name}" line="${test.line}" time="97" /></testsuite>`;
    expect(testDurationSamples(xml)[0]!.milliseconds).toBe(97_000);
    fs.writeFileSync(path.join(reports, 'run.junit.xml'), xml);
    const run = () => spawnSync('node', ['scripts/check-test-shards.mjs', '--test-reports', reports], { encoding: 'utf8' });
    const overrun = run();
    expect(overrun.status).not.toBe(0);
    expect(overrun.stderr).toContain('80% of its 120000ms test timeout');
    fs.writeFileSync(path.join(reports, 'run.junit.xml'), xml.replace('time="97"', 'time="30"'));
    expect(run().status).toBe(0);
  } finally { fs.rmSync(reports, { recursive: true, force: true }); }
});

test('transfers an introduced split duration floor once and preserves measured floors on refresh', () => {
  const workload: NodeWorkload = { runs: [{ source: 'recorded split', shardCount: 1, shards: [{ shard: 1, groups: [
    { label: 'combined', milliseconds: 250, files: { original: 250 }, splits: { original: { file: 'introduced', milliseconds: 125 } } },
  ] }] }] };
  const weights = mergeNodeDurationWeights({ original: 225, unrelated: 77 }, workload);
  expect(weights).toEqual({ original: 125, introduced: 125, unrelated: 77 });
  expect(weights.original! + weights.introduced!).toBeGreaterThanOrEqual(225);
  expect(mergeNodeDurationWeights(weights, workload)).toEqual(weights);
  expect(mergeNodeDurationWeights({ original: 150, introduced: 200 }, workload)).toEqual({ original: 150, introduced: 200 });
});

test('replays the complete hot CI workload with both extraction solos recorded', () => {
  const run = nodeWorkload.runs.find(value => value.source.includes('/40047399103/attempts/1'))!;
  expect(run).toBeDefined();
  expect(run.shards.map(shard => shard.shard)).toEqual([1, 2, 3, 4, 5]);
  const hot = run.shards[0]!;
  expect(hot.groups.reduce((sum, group) => sum + group.milliseconds, 0)).toBe(748_807);
  expect(hot.groups.reduce((sum, group) => sum + group.milliseconds, 0)).toBeGreaterThan(720_000);
  expect(hot.groups.find(group => group.label.endsWith('extraction-coverage-budget'))!.milliseconds).toBe(249_152);
  expect(hot.groups.find(group => group.label.endsWith('extraction-history-budget'))!.milliseconds).toBe(142_417);
});

test('replays a five-shard recording against a six-shard plan', () => {
  const shards = Array.from({ length: 5 }, (_, index) => ({
    shard: index + 1,
    groups: Array.from({ length: 2 }, (_, group) => ({
      label: `recorded ${index + 1}-${group}`, milliseconds: 100, files: { [`file-${index + 1}-${group}`]: 100 },
    })),
  }));
  const workload: NodeWorkload = { runs: [{ source: 'five-shard recording', shardCount: 5, shards }] };
  const groups = shards.flatMap(shard => shard.groups.map(group => ({
    label: group.label, files: Object.keys(group.files), estimatedMs: group.milliseconds,
  })));
  const plans = Array.from({ length: 6 }, (_, index) => selectShard(groups, { index: index + 1, count: 6 }, group => group.estimatedMs));
  expect(nodeDurationSamples(workload)[0]!.files).toEqual(Object.fromEntries(groups.map(group => [group.files[0]!, 100])));
  expect(() => assertNodeShardHeadroom(plans, 900_000, recordedNodeDurations(workload), workload)).not.toThrow();
});
