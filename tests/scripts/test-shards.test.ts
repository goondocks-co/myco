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
import { assertNodeShardHeadroom, nodeDurationSamples, nodeGroupBudget, recordedNodeDurations, type NodeGroup, type NodeWorkload } from '../../scripts/node-test-durations.mjs';

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
      const incomplete = { runs: nodeWorkload.runs.map(run => ({ ...run, shards: run.shards.slice(1) })) };
      expect(() => assertNodeShardHeadroom(plans, timeout, durations.files, incomplete)).toThrow('incomplete node workload');
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
