import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { derivePort, PORT_RANGE_START, PORT_RANGE_SIZE } from '@myco/daemon/port';
import { resolveServiceDir } from '@myco/grove/paths';
import { resolveGlobalDaemonPort } from '@myco/daemon/service-state';

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

describe('resolveGlobalDaemonPort — daemon.port override', () => {
  function homeWithConfig(yaml: string | null): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-port-'));
    if (yaml !== null) fs.writeFileSync(path.join(home, 'config.yaml'), yaml);
    return home;
  }

  it('returns the explicit daemon.port override when set + valid', () => {
    const home = homeWithConfig('daemon:\n  port: 19344\n  log_level: info\n');
    try {
      expect(resolveGlobalDaemonPort(home)).toBe(19344);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('derives from the service path when no config.yaml exists', () => {
    const home = homeWithConfig(null);
    try {
      expect(resolveGlobalDaemonPort(home)).toBe(derivePort(resolveServiceDir(home)));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('derives when daemon.port is absent or null (no override)', () => {
    const home = homeWithConfig('daemon:\n  log_level: debug\n  port: null\n');
    try {
      expect(resolveGlobalDaemonPort(home)).toBe(derivePort(resolveServiceDir(home)));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores an out-of-range override and falls back to derived', () => {
    const home = homeWithConfig('daemon:\n  port: 80\n');
    try {
      expect(resolveGlobalDaemonPort(home)).toBe(derivePort(resolveServiceDir(home)));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
