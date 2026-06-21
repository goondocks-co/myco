import { describe, it, expect } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { derivePort, PORT_RANGE_START, PORT_RANGE_SIZE } from '@myco/daemon/port';
import { resolveServiceDir } from '@myco/grove/paths';

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

  // The HOME is what separates two coexisting daemons' ports — not a prod/dev
  // service variant. Two installs in two homes derive distinct ports because
  // their service dirs (`<home>/service/`) differ.
  it('two homes derive distinct daemon ports (the home, not a variant, separates ports)', () => {
    const homeA = path.join(os.homedir(), '.myco');
    const homeB = path.join(os.homedir(), '.myco-dev');
    const portA = derivePort(resolveServiceDir(homeA));
    const portB = derivePort(resolveServiceDir(homeB));
    expect(portA).not.toBe(portB);
  });
});
