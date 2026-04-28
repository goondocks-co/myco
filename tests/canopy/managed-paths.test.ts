import { describe, it, expect } from 'bun:test';
import { getManagedExcludeSegments } from '@myco/canopy/managed-paths';
import { loadManifests } from '@myco/symbionts/detect';

describe('getManagedExcludeSegments', () => {
  it('contains the fixed Myco/tooling set', () => {
    const segs = getManagedExcludeSegments();
    for (const expected of ['.myco', '.agents', '.superpowers', '.context', '.playwright-mcp', '.playwright-cli']) {
      expect(segs).toContain(expected);
    }
  });

  it('contains every loaded symbiont manifest configDir', () => {
    const segs = new Set(getManagedExcludeSegments());
    for (const m of loadManifests()) {
      expect(segs.has(m.configDir.replace(/^\/+/, '').replace(/\/+$/, ''))).toBe(true);
    }
  });

  it('deduplicates segments', () => {
    const segs = getManagedExcludeSegments();
    expect(new Set(segs).size).toBe(segs.length);
  });
});
