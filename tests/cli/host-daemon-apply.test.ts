import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  restartDaemonForHostServe,
  writeHostServeConfig,
} from '@myco/team-host/daemon-apply.js';
import { clearHostState, readHostState, writeHostState, type HostState } from '@myco/team-host/state.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { resolveHostServeConfig, isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import { SCOPE_REGISTRY } from '@myco/config/scope.js';
import type { ServiceManager, ServiceStatus, InstallResult } from '@myco/service/types.js';

function fakeManager(over: Partial<ServiceManager> & { installed?: boolean; supported?: boolean } = {}): {
  manager: ServiceManager;
  restarts: string[];
} {
  const restarts: string[] = [];
  const manager: ServiceManager = {
    supported: over.supported ?? true,
    platformName: 'launchd',
    isInstalled: async () => over.installed ?? true,
    install: async (): Promise<InstallResult> => ({ changed: false, supervisorReloaded: false }),
    uninstall: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async (label: string) => { restarts.push(label); },
    restartShellCommand: (label: string) => `restart ${label}`,
    status: async (): Promise<ServiceStatus> => ({ installed: true, running: true, pid: 1, lastExitCode: null, unitPath: null }),
  };
  return { manager, restarts };
}

describe('writeHostServeConfig', () => {
  let tmp: string;
  let prevMyco: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-apply-'));
    prevMyco = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tmp, 'myco');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes daemon.host_serve to the machine tier with a 100.64 IP that satisfies Task 2.3', () => {
    writeHostServeConfig({ enabled: true, overlayAddress: '100.64.0.7' }, process.env.MYCO_HOME);

    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve).toEqual({
      enabled: true,
      overlay_address: '100.64.0.7',
      host_id: null,
      label: null,
      served_grove_id: null,
    });

    // The written address satisfies Task 2.3's downstream gate...
    expect(isOverlayRangeAddress(machine.daemon.host_serve.overlay_address)).toBe(true);
    // ...and resolves to a live HostServeRuntime (bind address + minted bearer).
    const runtime = resolveHostServeConfig({ machineConfig: machine, mycoHome: process.env.MYCO_HOME });
    expect(runtime?.overlayAddress).toBe('100.64.0.7');
    expect(runtime?.bearer.length).toBeGreaterThan(0);

    // The write lands ONLY in the machine config file, not a project vault.
    expect(fs.existsSync(path.join(process.env.MYCO_HOME!, 'config.yaml'))).toBe(true);
  });

  it('REFUSES to enable with a non-CGNAT address (would be rejected downstream)', () => {
    expect(() => writeHostServeConfig({ enabled: true, overlayAddress: '192.168.1.9' }, process.env.MYCO_HOME))
      .toThrow(/not a\s+100\.64\.0\.0\/10/);
    expect(() => writeHostServeConfig({ enabled: true, overlayAddress: '10.0.0.4' }, process.env.MYCO_HOME))
      .toThrow(/CGNAT/);
    // Nothing was written.
    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve.enabled).toBe(false);
  });

  it('clears host_serve on disable (enabled:false, address null → resolves off)', () => {
    writeHostServeConfig({ enabled: true, overlayAddress: '100.64.0.7' }, process.env.MYCO_HOME);
    writeHostServeConfig({ enabled: false, overlayAddress: null }, process.env.MYCO_HOME);
    const machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve).toEqual({
      enabled: false,
      overlay_address: null,
      host_id: null,
      label: null,
      served_grove_id: null,
    });
    expect(resolveHostServeConfig({ machineConfig: machine, mycoHome: process.env.MYCO_HOME })).toBeNull();
  });

  it('disable CLEARS served_grove_id (spec §8 — a stale designation must not survive disable → re-enable)', () => {
    writeHostServeConfig(
      { enabled: true, overlayAddress: '100.64.0.7', servedGroveId: 'grove_' + '0'.repeat(32) },
      process.env.MYCO_HOME,
    );
    let machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve.served_grove_id).toBe('grove_' + '0'.repeat(32));

    writeHostServeConfig({ enabled: false, overlayAddress: null }, process.env.MYCO_HOME);
    machine = loadMachineConfig(process.env.MYCO_HOME);
    expect(machine.daemon.host_serve.served_grove_id).toBeNull();
  });

  it('host_serve is a machine-tier field a project cannot override (scope registry)', () => {
    // The structural guarantee: `daemon.host_serve` is registered machine-tier
    // with an EMPTY overridableBy set, so no project/grove/local tier can shadow
    // it — resolveHostServeConfig reads loadMachineConfig directly, never a merge.
    expect(SCOPE_REGISTRY['daemon.host_serve']).toEqual({ home: 'machine', overridableBy: [] });
  });
});

describe('restartDaemonForHostServe', () => {
  it('restarts the daemon service when installed', async () => {
    const { manager, restarts } = fakeManager({ installed: true });
    const result = await restartDaemonForHostServe('/home/x/.myco', manager);
    expect(result.restarted).toBe(true);
    expect(restarts).toHaveLength(1);
  });

  it('surfaces a manual-restart instruction when the daemon is not service-managed', async () => {
    const { manager, restarts } = fakeManager({ installed: false });
    const result = await restartDaemonForHostServe('/home/x/.myco', manager);
    expect(result.restarted).toBe(false);
    expect(result.detail).toMatch(/restart it manually/);
    expect(restarts).toHaveLength(0);
  });

  it('does not throw on an unsupported platform', async () => {
    const { manager } = fakeManager({ supported: false });
    const result = await restartDaemonForHostServe('/home/x/.myco', manager);
    expect(result.restarted).toBe(false);
  });
});

describe('host state record', () => {
  let tmp: string;
  let prevTeam: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-state-'));
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
  });
  afterEach(() => {
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const sample: HostState = {
    host_id: 'host_' + '0'.repeat(32),
    enabled_at: '2026-07-07T00:00:00.000Z',
    server_url: 'https://host:8080',
    overlay_address: '100.64.0.1',
    headscale_user: 'myco-host',
    headscale_version: '0.29.2',
    tailscale_version: '1.98.8',
    platform: 'darwin',
    headscale_bin: '/x/bin/headscale',
    tailscale_bin: '/opt/homebrew/bin/tailscale',
    tailscaled_bin: '/opt/homebrew/bin/tailscaled',
  };

  it('round-trips and clears', () => {
    expect(readHostState()).toBeNull();
    writeHostState(sample);
    expect(readHostState()).toEqual(sample);
    clearHostState();
    expect(readHostState()).toBeNull();
  });
});
