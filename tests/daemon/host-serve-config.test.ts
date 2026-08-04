/**
 * Team Host — host-serve enablement resolution (Task 2.3). The machine-tier
 * `daemon.host_serve` opt-in resolves to a `HostServeRuntime` (bind address +
 * minted bearer) or `null` (host serving off), never throwing: an enabled-but-
 * misconfigured host yields `null` + one log, never a crash and never a wildcard
 * bind.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveHostServeBearer as resolveHostServeBearerWith,
  resolveHostServeConfig as resolveHostServeConfigWith,
} from '@myco/daemon/host-serve';
import { MachineConfigSchema, type MachineConfig } from '@myco/config/schema';
import { readSecrets } from '@myco/config/secrets';
import { HOST_SERVE_BEARER_SECRET } from '@myco/constants';
import { LOG_KINDS } from '@myco/constants/log-kinds';
import { createGrove } from '@myco/grove/registry';
import { resolveGroveMetadataPath } from '@myco/grove/paths';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const resolveHostServeBearer = (mycoHome?: string) =>
  resolveHostServeBearerWith(mycoHome, testPerUserLockNamespace);
const resolveHostServeConfig = (
  options: Parameters<typeof resolveHostServeConfigWith>[0],
) => resolveHostServeConfigWith({
  ...options,
  lockNamespace: testPerUserLockNamespace,
});

function machineConfig(hostServe?: {
  enabled?: boolean;
  served_grove_id?: string | null;
}): MachineConfig {
  return MachineConfigSchema.parse(
    hostServe ? { daemon: { host_serve: hostServe } } : {},
  );
}

describe('resolveHostServeConfig', () => {
  let home: string;
  let warnings: Array<{ kind: string; message: string }>;
  const logger = {
    info: () => {},
    warn: (kind: string, message: string) => { warnings.push({ kind, message }); },
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hs-cfg-'));
    warnings = [];
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('disabled → null, no warning', () => {
    const rt = resolveHostServeConfig({ machineConfig: machineConfig(), mycoHome: home, logger });
    expect(rt).toBeNull();
    expect(warnings).toHaveLength(0);
  });

  test('enabled → runtime with a minted, persisted, stable bearer', () => {
    // Enablement no longer depends on an address or a port. The listener binds a
    // socket derived from MYCO_HOME, so what `host_serve` carries is identity and
    // designation — what a host IS, not where it can be reached.
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.bearer.length).toBeGreaterThan(0);
    expect(warnings).toHaveLength(0);

    const persisted = readSecrets(home)[HOST_SERVE_BEARER_SECRET];
    expect(persisted).toBe(rt!.bearer);

    // Stable across resolves — a second call never re-mints.
    const again = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true }),
      mycoHome: home,
      logger,
    });
    expect(again!.bearer).toBe(rt!.bearer);
  });

  test('enabled with a designation surfaces it on the runtime', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, served_grove_id: null }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.servedGroveId).toBeUndefined();
  });
});

describe('resolveHostServeBearer', () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hs-bearer-')); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  test('mints + persists on first use, returns the same value thereafter', () => {
    const first = resolveHostServeBearer(home);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveHostServeBearer(home)).toBe(first);
    expect(readSecrets(home)[HOST_SERVE_BEARER_SECRET]).toBe(first);
  });
});
