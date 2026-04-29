/**
 * End-to-end coverage for the v8 Cortex path unification.
 *
 * Each test walks the same path the live UI takes:
 *   ScopedField onChange → PUT /api/config/scoped → updateConfig →
 *   saveConfig → Zod parse → write to myco.yaml (or local.yaml) →
 *   GET /api/config/merged → assert the value landed at the new path.
 *
 * If any of the renames in v8 missed a callsite, a path string drifted,
 * or the patch endpoint can't deep-merge into the new shape, one of
 * these will fail. This is the safety net Chris asked for: the unit
 * suite confirmed each layer in isolation; this confirms the layers
 * stack correctly when patched through the live HTTP surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  handleGetMergedConfig,
  handlePutScopedConfig,
} from '@myco/daemon/api/config';
import { CORTEX_PATHS, AGENT_PATHS } from '@myco/config/paths';
import type { MycoConfig } from '@myco/config/schema';

function seedFreshVault(dir: string): void {
  // Minimal myco.yaml — schema defaults fill in everything else, just
  // like a real `myco init` output.
  fs.writeFileSync(
    path.join(dir, 'myco.yaml'),
    `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`,
  );
}

function readYaml(file: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

/**
 * Drill into a config object via a dotted path. Used to assert against
 * effective values returned from /api/config/merged.
 */
function getAtPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    obj,
  );
}

/**
 * Convert a dotted path + leaf value into the nested object the patch
 * endpoint expects. e.g. ('a.b.c', 5) → { a: { b: { c: 5 } } }.
 */
function patchFromPath(dotted: string, value: unknown): Record<string, unknown> {
  const parts = dotted.split('.');
  const result: Record<string, unknown> = {};
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    cursor[parts[i]!] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]!] = value;
  return result;
}

describe('PUT /api/config/scoped — cortex paths land at the v8 shape', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cortex-paths-'));
    seedFreshVault(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Each entry: a path string, a non-default value to patch, and the expected return type. */
  const cases: Array<{ path: string; value: unknown }> = [
    { path: CORTEX_PATHS.enabled, value: false },
    { path: CORTEX_PATHS.instructions.injectOnSessionStart, value: false },
    { path: CORTEX_PATHS.digest.tier, value: 10000 },
    { path: CORTEX_PATHS.digest.injectOnSessionStart, value: true },
    { path: CORTEX_PATHS.spores.injectOnPromptSubmit, value: false },
    { path: CORTEX_PATHS.spores.maxPerPrompt, value: 7 },
    { path: CORTEX_PATHS.canopy.injectOnPreToolUse, value: false },
    { path: CORTEX_PATHS.canopy.minFileBytes, value: 1500 },
    { path: CORTEX_PATHS.canopy.refresh.backgroundEnabled, value: false },
    { path: CORTEX_PATHS.canopy.refresh.backgroundPeriodMinutes, value: 15 },
    { path: CORTEX_PATHS.canopy.exclude.patterns, value: ['fixtures/large/**'] },
  ];

  for (const { path: configPath, value } of cases) {
    it(`project scope: writes ${configPath} = ${JSON.stringify(value)} to myco.yaml`, async () => {
      const res = await handlePutScopedConfig(tmpDir, {
        scope: 'project',
        patch: patchFromPath(configPath, value),
      });
      expect(res.status === undefined || res.status < 400).toBe(true);

      // Disk: the YAML on disk has the value at the canonical path.
      const onDisk = readYaml(path.join(tmpDir, 'myco.yaml'));
      expect(getAtPath(onDisk, configPath)).toEqual(value);

      // Effective: GET /merged returns the same value.
      const merged = await handleGetMergedConfig(tmpDir);
      expect(getAtPath(merged.body, configPath)).toEqual(value);
    });

    it(`local scope: writes ${configPath} = ${JSON.stringify(value)} to local.yaml`, async () => {
      const res = await handlePutScopedConfig(tmpDir, {
        scope: 'local',
        patch: patchFromPath(configPath, value),
      });
      expect(res.status === undefined || res.status < 400).toBe(true);

      // Disk: local.yaml carries the override; myco.yaml is unchanged.
      const local = readYaml(path.join(tmpDir, 'local.yaml'));
      expect(getAtPath(local, configPath)).toEqual(value);

      // Merged: project (default) overlaid with local (override) yields the override.
      const merged = await handleGetMergedConfig(tmpDir);
      expect(getAtPath(merged.body, configPath)).toEqual(value);
    });
  }

  it('clearing a cortex.* override drops it back to the project value', async () => {
    // 1. Set a project value.
    await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { cortex: { spores: { max_per_prompt: 5 } } },
    });
    // 2. Override at local.
    await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      patch: { cortex: { spores: { max_per_prompt: 9 } } },
    });
    let merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as MycoConfig).cortex.spores.max_per_prompt).toBe(9);

    // 3. Clear the local override.
    await handlePutScopedConfig(tmpDir, {
      scope: 'local',
      clear: [CORTEX_PATHS.spores.maxPerPrompt],
    });
    merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as MycoConfig).cortex.spores.max_per_prompt).toBe(5);
  });

  it('rejects an invalid cortex.canopy.min_file_bytes (non-integer)', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { cortex: { canopy: { min_file_bytes: 1.5 } } },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('validation_failed');
  });

  it('rejects an invalid cortex.spores.max_per_prompt (out of range)', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { cortex: { spores: { max_per_prompt: 11 } } },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('validation_failed');
  });

  it('a cortex.* patch deep-merges with sibling features (no clobbering)', async () => {
    // Patch one digest field; spores.max_per_prompt stays at default.
    await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { cortex: { digest: { tier: 1500 } } },
    });
    const merged = await handleGetMergedConfig(tmpDir);
    const cfg = merged.body as MycoConfig;
    expect(cfg.cortex.digest.tier).toBe(1500);
    expect(cfg.cortex.spores.max_per_prompt).toBe(3); // default preserved
    expect(cfg.cortex.instructions.inject_on_session_start).toBe(true); // default preserved
    expect(cfg.cortex.canopy.inject_on_pre_tool_use).toBe(true); // default preserved
  });
});

describe('non-cortex paths still work post-v8 (regression check)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-non-cortex-'));
    seedFreshVault(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('agent.scheduled_tasks_enabled toggles cleanly', async () => {
    const res = await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: patchFromPath(AGENT_PATHS.scheduledTasksEnabled, false),
    });
    expect(res.status === undefined || res.status < 400).toBe(true);
    const merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as MycoConfig).agent.scheduled_tasks_enabled).toBe(false);
  });

  it('appearance.theme toggle is unaffected by the cortex move', async () => {
    await handlePutScopedConfig(tmpDir, {
      scope: 'project',
      patch: { appearance: { theme: 'moss' } },
    });
    const merged = await handleGetMergedConfig(tmpDir);
    expect((merged.body as MycoConfig).appearance.theme).toBe('moss');
  });
});
