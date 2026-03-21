import { describe, it, expect } from 'vitest';
import { derivePort, PORT_RANGE_START, PORT_RANGE_SIZE } from '@myco/daemon/port';

describe('derivePort', () => {
  it('derives a port in the valid range from a vault path', () => {
    const port = derivePort('/Users/chris/.myco/vaults/myco');
    expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
    expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
  });

  it('returns the same port for the same path', () => {
    const a = derivePort('/Users/chris/.myco/vaults/myco');
    const b = derivePort('/Users/chris/.myco/vaults/myco');
    expect(a).toBe(b);
  });

  it('returns different ports for different paths', () => {
    const a = derivePort('/Users/chris/.myco/vaults/myco');
    const b = derivePort('/Users/chris/.myco/vaults/other-project');
    expect(a).not.toBe(b);
  });
});
