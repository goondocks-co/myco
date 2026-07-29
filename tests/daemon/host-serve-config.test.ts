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
  isBindableOverlayAddress,
  isOverlayRangeAddress,
  resolveHostServeBearer as resolveHostServeBearerWith,
  resolveHostServeConfig as resolveHostServeConfigWith,
  formatOverlayAuthority,
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
  overlay_address?: string | null;
  overlay_port?: number | null;
  served_grove_id?: string | null;
}): MachineConfig {
  // Default a valid overlay_port so each test states only what it is about;
  // the port's own fail-closed behaviour has dedicated tests below.
  const withPort = hostServe
    ? { overlay_port: 41443, ...hostServe }
    : undefined;
  return MachineConfigSchema.parse(
    withPort ? { daemon: { host_serve: withPort } } : {},
  );
}

describe('isBindableOverlayAddress', () => {
  test('rejects wildcards, empties, and URLs', () => {
    for (const bad of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*', '[::]', '', '   ', 'http://100.64.0.1']) {
      expect(isBindableOverlayAddress(bad)).toBe(false);
    }
    expect(isBindableOverlayAddress(null)).toBe(false);
    expect(isBindableOverlayAddress(undefined)).toBe(false);
  });

  test('accepts a concrete overlay/loopback IP', () => {
    expect(isBindableOverlayAddress('100.64.0.5')).toBe(true);
    expect(isBindableOverlayAddress('127.0.0.1')).toBe(true);
  });
});

describe('isOverlayRangeAddress (CGNAT 100.64.0.0/10)', () => {
  test('accepts addresses inside 100.64.0.0/10', () => {
    for (const ok of ['100.64.0.0', '100.64.0.5', '100.100.1.1', '100.127.255.255']) {
      expect(isOverlayRangeAddress(ok)).toBe(true);
    }
  });

  test('rejects LAN, public, loopback, wildcard, boundary-adjacent, and IPv6 addresses', () => {
    for (const bad of [
      '100.63.255.255', // just below the /10
      '100.128.0.0',    // just above the /10
      '192.168.1.5',    // LAN
      '10.0.0.1',       // LAN
      '172.16.0.1',     // LAN
      '8.8.8.8',        // public
      '127.0.0.1',      // loopback
      '0.0.0.0',        // wildcard
      '100.64.0.256',   // malformed octet
      'fd7a:115c:a1e0::1', // IPv6 (v4-only gate)
      '100.64.0',       // partial
    ]) {
      expect(isOverlayRangeAddress(bad)).toBe(false);
    }
    expect(isOverlayRangeAddress(null)).toBe(false);
  });
});

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

  test('enabled but no overlay_address → null + one warning, no bearer minted', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: null }),
      mycoHome: home,
      logger,
    });
    expect(rt).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(readSecrets(home)[HOST_SERVE_BEARER_SECRET]).toBeUndefined();
  });

  test('enabled with a wildcard 0.0.0.0 → null (never a wildcard bind) + one warning', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: '0.0.0.0' }),
      mycoHome: home,
      logger,
    });
    expect(rt).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  test('enabled with a LAN/public address (not CGNAT) → null + one warning, no bearer minted', () => {
    for (const addr of ['192.168.1.10', '8.8.8.8']) {
      warnings = [];
      const rt = resolveHostServeConfig({
        machineConfig: machineConfig({ enabled: true, overlay_address: addr }),
        mycoHome: home,
        logger,
      });
      expect(rt).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(readSecrets(home)[HOST_SERVE_BEARER_SECRET]).toBeUndefined();
    }
  });

  test('enabled with a valid overlay IP → runtime with a minted, persisted, stable bearer', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: '100.64.0.5' }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.overlayAddress).toBe('100.64.0.5');
    expect(rt!.bearer).toMatch(/^[0-9a-f]{64}$/);
    expect(warnings).toHaveLength(0);

    // Bearer is persisted machine-scoped and stable across a re-resolve.
    expect(readSecrets(home)[HOST_SERVE_BEARER_SECRET]).toBe(rt!.bearer);
    const again = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: '100.64.0.5' }),
      mycoHome: home,
      logger,
    });
    expect(again!.bearer).toBe(rt!.bearer);
  });

  test('enabled with served_grove_id naming an existing Grove → runtime carries servedGroveId', () => {
    const grove = createGrove('Team', home);
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({
        enabled: true,
        overlay_address: '100.64.0.5',
        served_grove_id: grove.id,
      }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.servedGroveId).toBe(grove.id);
    expect(warnings).toHaveLength(0);
  });

  test('enabled with served_grove_id naming a MISSING Grove → null + one dangling-designation warning', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({
        enabled: true,
        overlay_address: '100.64.0.5',
        served_grove_id: 'grove_' + '0'.repeat(32),
      }),
      mycoHome: home,
      logger,
    });
    expect(rt).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe(LOG_KINDS.HOST_SERVE);
    expect(warnings[0].message).toMatch(/served_grove_id/);
    // A dangling designation must not mint/persist a bearer either — same
    // no-side-effects-on-refusal contract as the address gate above.
    expect(readSecrets(home)[HOST_SERVE_BEARER_SECRET]).toBeUndefined();
  });

  test('enabled with served_grove_id: null still RESOLVES (fail-closed is enforced downstream by Task 2)', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({
        enabled: true,
        overlay_address: '100.64.0.5',
        served_grove_id: null,
      }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.servedGroveId).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test('enabled with served_grove_id: "" (empty string) normalizes to absent, same as null', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({
        enabled: true,
        overlay_address: '100.64.0.5',
        served_grove_id: '   ',
      }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.servedGroveId).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  test('listGroves() throwing (corrupt UNRELATED grove.toml on the machine) → null + one warning, never throws', () => {
    // An unrelated grove with unreadable/corrupt metadata must not crash the
    // boot check for a completely different served_grove_id — listGroves()
    // walks + TOML-parses EVERY grove on the machine, so one bad grove.toml
    // throws while resolving an unrelated designation too.
    const corrupt = createGrove('Corrupt', home);
    fs.writeFileSync(resolveGroveMetadataPath(corrupt.id, home), '[grove\nid = "unterminated', 'utf-8');

    let rt: ReturnType<typeof resolveHostServeConfig>;
    expect(() => {
      rt = resolveHostServeConfig({
        machineConfig: machineConfig({
          enabled: true,
          overlay_address: '100.64.0.5',
          served_grove_id: 'grove_' + '9'.repeat(32),
        }),
        mycoHome: home,
        logger,
      });
    }).not.toThrow();

    expect(rt!).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe(LOG_KINDS.HOST_SERVE);
    expect(warnings[0].message).toMatch(/served_grove_id/);
  });

  // --- overlay_port, coexistence amendment §8 -------------------------------

  test('enabled with NO overlay_port → null, one warning (never falls back to the daemon port)', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: '100.64.0.7', overlay_port: null }),
      mycoHome: home,
      logger,
    });

    // The fallback this replaces (`?? this.port`) bound the overlay listener at
    // the address the loopback listener already holds; the resulting EADDRINUSE
    // was swallowed into one warn while status still reported `serving: true`.
    expect(rt).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe(LOG_KINDS.HOST_SERVE);
    expect(warnings[0].message).toMatch(/overlay_port is absent or out of range/);
  });

  test('an out-of-range overlay_port on disk is refused, not coerced', () => {
    // Hand-edited config bypasses the schema's range check, so the resolver
    // must refuse independently rather than trusting upstream validation.
    const base = machineConfig({ enabled: true, overlay_address: '100.64.0.7' });
    const tampered = {
      ...base,
      daemon: { ...base.daemon, host_serve: { ...base.daemon.host_serve, overlay_port: 0 } },
    } as MachineConfig;

    expect(resolveHostServeConfig({ machineConfig: tampered, mycoHome: home, logger })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/overlay_port is absent or out of range/);
  });

  test('a valid overlay_port surfaces on the runtime and composes the advertised authority', () => {
    const rt = resolveHostServeConfig({
      machineConfig: machineConfig({ enabled: true, overlay_address: '100.64.0.7', overlay_port: 41443 }),
      mycoHome: home,
      logger,
    });
    expect(rt).not.toBeNull();
    expect(rt!.overlayPort).toBe(41443);
    // The ONE producer every advertising surface goes through.
    expect(formatOverlayAuthority(rt!.overlayAddress, rt!.overlayPort)).toBe('100.64.0.7:41443');
    expect(warnings).toHaveLength(0);
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
