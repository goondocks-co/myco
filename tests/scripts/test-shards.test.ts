import { describe, expect, test } from 'bun:test';
import { parseShard, selectGroup, selectShard } from '../../scripts/test-shards.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('test shard selection', () => {
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
