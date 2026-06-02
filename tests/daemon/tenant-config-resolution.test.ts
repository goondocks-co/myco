/**
 * Tenant config-resolution regression test for `resolveTenantConfig`.
 *
 * Daemon tenant request handlers must resolve config for the REQUEST's tenant
 * — `loadMergedConfig(<request project vaultDir>, { groveId })` — NOT from the
 * daemon's `liveConfig.current`. On the global daemon `liveConfig.current` is
 * the merged config for the daemon's bootstrap home (a phantom home
 * post-Phase-5, or an arbitrary anchor project before). Reading grove/
 * project-tier fields (`cortex.*`, `agent.event_tasks_enabled`,
 * `agent.summary_batch_interval`) from it gates a tenant request on the wrong
 * grove's config.
 *
 * `resolveTenantConfig` is the shared helper that closes this leak class. It
 * resolves the request grove's merged config, and falls back to the supplied
 * `fallback` (the daemon's liveConfig) ONLY when no tenant context is
 * resolvable — and never throws.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  saveGroveConfig,
  saveMachineConfig,
  invalidateMergedConfigCache,
} from '@myco/config/loader';
import type { MycoConfig } from '@myco/config/schema.js';
import { resolveTenantConfig } from '@myco/daemon/request-config';

const GROVE_B_ID = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('resolveTenantConfig resolves config from the request grove', () => {
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let vaultB: string;
  // A fallback config that carries the OPPOSITE grove-tier value so any leak
  // of the daemon liveConfig into a tenant op is observable.
  let fallback: MycoConfig;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenant-config-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    invalidateMergedConfigCache();

    // Machine tier carries no agent overrides so the per-grove difference is
    // not masked by a bootstrap default.
    saveMachineConfig({} as never);

    // Grove B sets a distinctive grove-tier value: event tasks DISABLED and a
    // distinctive summary cadence. The schema default for both is the opposite
    // (event_tasks_enabled: true, summary_batch_interval: 5).
    saveGroveConfig(GROVE_B_ID, {
      agent: { event_tasks_enabled: false, summary_batch_interval: 99 },
    } as never);

    // Project vault carries only a minimal myco.yaml — no agent overrides — so
    // the merged result's agent block comes purely from the grove tier.
    vaultB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenant-config-vault-b-'));
    fs.writeFileSync(path.join(vaultB, 'myco.yaml'), 'version: 3\n', 'utf-8');
    invalidateMergedConfigCache();

    // Fallback (the daemon liveConfig stand-in) carries the OPPOSITE values.
    fallback = loadFallback();
  });

  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(vaultB, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    invalidateMergedConfigCache();
  });

  // Build a fallback config with the opposite grove-tier values from an empty
  // vault (no grove bound) so its agent block reflects the schema defaults
  // (event_tasks_enabled: true, summary_batch_interval: 5).
  function loadFallback(): MycoConfig {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenant-config-fallback-'));
    fs.writeFileSync(path.join(tmp, 'myco.yaml'), 'version: 3\n', 'utf-8');
    // Import lazily to avoid a top-level cycle; loadMergedConfig with no grove.
    const { loadMergedConfig } = require('@myco/config/loader');
    const cfg = loadMergedConfig(tmp, { groveId: null }) as MycoConfig;
    fs.rmSync(tmp, { recursive: true, force: true });
    return cfg;
  }

  it("returns the REQUEST grove's config, not the fallback", () => {
    // Sanity: the fallback carries the opposite values.
    expect(fallback.agent.event_tasks_enabled).toBe(true);
    expect(fallback.agent.summary_batch_interval).toBe(5);

    const result = resolveTenantConfig(
      { projectVaultDir: vaultB, groveId: GROVE_B_ID },
      fallback,
    );

    // The result reflects grove B's grove-tier overrides — NOT the fallback.
    expect(result.agent.event_tasks_enabled).toBe(false);
    expect(result.agent.summary_batch_interval).toBe(99);
  });

  it('returns the fallback when tenancy is undefined', () => {
    const result = resolveTenantConfig(undefined, fallback);
    expect(result).toBe(fallback);
  });

  it('returns the fallback when groveId is null', () => {
    const result = resolveTenantConfig(
      { projectVaultDir: vaultB, groveId: null },
      fallback,
    );
    expect(result).toBe(fallback);
  });

  it('returns the fallback when groveId is missing', () => {
    const result = resolveTenantConfig({ projectVaultDir: vaultB }, fallback);
    expect(result).toBe(fallback);
  });

  it('returns the fallback when projectVaultDir is missing', () => {
    const result = resolveTenantConfig({ groveId: GROVE_B_ID }, fallback);
    expect(result).toBe(fallback);
  });

  it('returns the fallback (fail-soft) when loadMergedConfig throws', () => {
    // Point projectVaultDir at a regular FILE, not a directory. Internal config
    // resolution joins paths under it and reads/migrates them, which throws
    // ENOTDIR. The helper must swallow that and return the fallback unchanged,
    // never propagating the throw to the tenant request handler.
    const notADir = path.join(mycoHome, 'this-is-a-file-not-a-dir');
    fs.writeFileSync(notADir, 'not a directory\n', 'utf-8');

    let result: MycoConfig | undefined;
    expect(() => {
      result = resolveTenantConfig(
        { projectVaultDir: notADir, groveId: GROVE_B_ID },
        fallback,
      );
    }).not.toThrow();
    expect(result).toBe(fallback);
  });
});
