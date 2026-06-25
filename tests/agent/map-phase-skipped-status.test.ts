import { describe, expect, test } from 'bun:test';
import { mapResultToPhaseStatus } from '@myco/agent/phase-loop.js';

describe('mapResultToPhaseStatus', () => {
  test('providerUnavailable with no writes → skipped', () => {
    const r = { providerUnavailable: true, written: 0, failed: 0, skipped: 0 } as any;
    expect(mapResultToPhaseStatus(r)).toBe('skipped');
  });
  test('some writes despite a late outage → completed', () => {
    const r = { providerUnavailable: true, written: 3, failed: 0, skipped: 0 } as any;
    expect(mapResultToPhaseStatus(r)).toBe('completed');
  });
});
