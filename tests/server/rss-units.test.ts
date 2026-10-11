import { expect, it } from 'bun:test';
import { readTestPeakRssKiB, rssKiB } from '../../scripts/test-process-tree.mjs';

it('normalizes byte and KiB RSS samples to the same unit', () => {
  expect(rssKiB(64 * 1024 ** 2, 'bytes')).toBe(64 * 1024);
  expect(rssKiB(64 * 1024, 'KiB')).toBe(64 * 1024);
});

it('reports a live high-water mark within twice the resident KiB', () => {
  const residentKiB = process.memoryUsage().rss / 1024;
  const peak = readTestPeakRssKiB();
  expect(peak).toBeGreaterThan(residentKiB / 2);
  expect(peak).toBeLessThan(residentKiB * 2);
});
