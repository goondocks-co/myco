import { describe, expect, test } from 'bun:test';
import { groupByDuration, parseShard, selectGroup, selectShard } from '../../scripts/test-shards.mjs';
import { spawnSync } from 'node:child_process';
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
      const legacy = 'tests/setup/journeys-legacy.test.ts';
      const early = 'tests/setup/create-sigkill-resume-local-early.test.ts';
      const journeys = groups.find(group => group.includes(legacy));
      expect(journeys).toContain(legacy);
      expect(journeys).not.toContain(early);
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
  test('caps node shards at eleven minutes of measured work within the job timeout', () => {
    const weights: Record<string, number> = { first: 220_000, second: 220_000, third: 220_000 };
    const groups = Object.entries(weights).map(([file, estimatedMs]) => ({ label: file, files: [file], estimatedMs }));
    const plans = [groups, ...Array.from({ length: 7 }, () => [])];
    expect(() => assertNodeShardHeadroom(plans, 900_000, weights, { runs: [] })).not.toThrow();
    const excessive: Record<string, number> = { ...weights, third: weights.third! + 1 };
    const over = [groups.map(group => ({ ...group, estimatedMs: excessive[group.label]! })), ...plans.slice(1)];
    expect(() => assertNodeShardHeadroom(over, 900_000, excessive, { runs: [] })).toThrow('with headroom');
  });
  test('retains recorded node process wall time when splitting a file into balancing units', () => {
    for (const [index, sample] of nodeDurationSamples(nodeWorkload).entries()) {
      const elapsed = nodeWorkload.runs[index]!.shards.flatMap(shard => shard.groups).reduce((sum, group) => sum + group.milliseconds, 0);
      expect(Object.values(sample.files).reduce((sum, milliseconds) => sum + milliseconds, 0)).toBeCloseTo(elapsed, 5);
    }
  });
  test('rejects incomplete measurements, missing weights and exhausted group headroom', () => {
    const group = { label: 'fixture', files: ['first', 'second'], estimatedMs: 20 };
    const plans = [[group], [], [], [], []];
    const workload: NodeWorkload = { runs: [{ source: 'fixture', shardCount: 1, shards: [{
      shard: 1, groups: [{ ...group, milliseconds: 20, files: { first: 10, second: 10 } }],
    }] }] };
    expect(() => assertNodeShardHeadroom(plans, 900_000, { first: 10, second: 10 }, workload)).not.toThrow();
    expect(() => assertNodeShardHeadroom(plans, 900_000, { first: 9, second: 10 }, workload)).toThrow('Stale node duration');
    expect(() => assertNodeShardHeadroom(plans, 900_000, { first: 10 }, workload)).toThrow('explicit duration weight');
    expect(() => assertNodeShardHeadroom(plans, 900_000, { first: 300_000, second: 10 }, workload)).toThrow('split the group');
    const incomplete = { runs: [{ ...workload.runs[0]!, shardCount: 2 }] };
    expect(() => assertNodeShardHeadroom(plans, 900_000, { first: 10, second: 10 }, incomplete)).toThrow('incomplete node workload');
  });
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
    expect(overrun.stderr).toContain('Split the variants or raise the declared timeout.');
    const reported = spawnSync('node', ['scripts/check-test-shards.mjs', '--test-reports', reports], {
      encoding: 'utf8',
      env: { ...process.env, MYCO_TIMING_GATES: 'enforce', MYCO_TEST_HEADROOM: 'report', GITHUB_STEP_SUMMARY: path.join(reports, 'summary.md') },
    });
    expect(reported.status).toBe(0);
    expect(reported.stdout).toContain(test.file);
    expect(reported.stdout).toContain(test.name);
    expect(reported.stdout).toContain('97000ms');
    expect(reported.stdout).toContain('120000ms');
    expect(reported.stdout).toContain('Split the variants or raise the declared timeout.');
    expect(fs.readFileSync(path.join(reports, 'summary.md'), 'utf8')).toContain('Split the variants or raise the declared timeout.');
    const timingEnv: NodeJS.ProcessEnv = { ...process.env, MYCO_TIMING_GATES: 'report' };
    delete timingEnv.MYCO_TEST_HEADROOM;
    const timingOnly = spawnSync('node', ['scripts/check-test-shards.mjs', '--test-reports', reports], {
      encoding: 'utf8',
      env: timingEnv,
    });
    expect(timingOnly.status).not.toBe(0);
    fs.writeFileSync(path.join(reports, 'run.junit.xml'), xml.replace('time="97"', 'time="30"'));
    expect(run().status).toBe(0);
    fs.writeFileSync(path.join(reports, 'run.junit.xml'), '<testsuite><testcase file="tests/meta/container-bun-pin.test.ts" name="unknown case" line="1" time="4000" /></testsuite>');
    const unmeasured = run();
    expect(unmeasured.status).not.toBe(0);
    expect(unmeasured.stderr).toContain('matching its recorded name');
    fs.writeFileSync(path.join(reports, 'run.junit.xml'), '<testsuite/>');
    expect(run().status).not.toBe(0);
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

test('resolves real JUnit tuple and object registrations, scoped duplicate names and imported timeouts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-junit-'));
  try {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'bundler' } }));
    fs.writeFileSync(path.join(root, 'limits.ts'), 'export const LIMIT = 45000;');
    fs.writeFileSync(path.join(root, 'cases.test.ts'), `import { describe, it } from 'bun:test';
import { LIMIT } from './limits';
describe('outer', () => { describe('inner', () => { const BOUND = LIMIT * 2;
  it.each([['tuple', 1]])(\n    '%s %d', () => {}, BOUND);
  it.each([{ name: 'object' }])('$name', () => {}, LIMIT);
  it('duplicate', () => {}, LIMIT);
}); });
describe('other', () => { const BOUND = 70000; it('duplicate', () => {}, BOUND); });
const unknownTimeout = Number('50000');
it('unresolved', () => {}, unknownTimeout);
`);
    const report = path.join(root, 'cases.xml');
    const run = spawnSync(process.execPath, ['test', './cases.test.ts', '--reporter=junit', '--reporter-outfile', report], { cwd: root, encoding: 'utf8' });
    expect({ status: run.status, error: run.stderr }).toEqual({ status: 0, error: expect.any(String) });
    const cases = testDurationSamples(fs.readFileSync(report, 'utf8')).map(test => ({ ...test, file: 'cases.test.ts' }));
    expect(cases).toHaveLength(5);
    expect(cases.slice(0, 4).map(test => declaredTestTimeout(root, test))).toEqual([90000, 45000, 45000, 70000]);
    expect(() => declaredTestTimeout(root, cases[4]!)).toThrow('cannot resolve');
    expect(() => declaredTestTimeout(root, { ...cases[0]!, classname: 'missing' })).toThrow('matching its recorded name');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
