import { describe, it, expect } from 'bun:test';
import { loadManifests } from '@myco/symbionts/detect.js';

describe('loadManifests', () => {
  it('loads all symbiont manifests', () => {
    const manifests = loadManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(2);
    const names = manifests.map(m => m.name);
    expect(names).toContain('claude-code');
    expect(names).toContain('cursor');
  });
});
