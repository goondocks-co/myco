import { describe, expect, test } from 'bun:test';
import { parseShard, selectShard } from '../../scripts/test-shards.mjs';

describe('test shard selection', () => {
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
