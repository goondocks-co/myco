import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { handleGetConfig, handleGetMergedConfig, handlePutScopedConfig } from '@myco/daemon/api/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

describe('config API', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-api-'));
    const config = { version: 3, embedding: { provider: 'ollama', model: 'bge-m3' } };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('GET returns parsed config', async () => {
    const result = await handleGetConfig(vaultDir);
    expect(result.body).toHaveProperty('version', 3);
  });

  it('PUT scoped patch merges and saves config', async () => {
    // capture.* moved to Machine tier (2026-06 scope correction), so a project
    // scoped PUT now uses a project-tier field (release_provenance.*).
    const result = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: {
        release_provenance: { production_debug_include_unknown: false },
      },
    });
    expect(result.status).toBeUndefined(); // 200 default
    const saved = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as {
      release_provenance?: { production_debug_include_unknown?: boolean };
    };
    expect(saved.release_provenance?.production_debug_include_unknown).toBe(false);
  });

  it('PUT scoped patch preserves unrelated sections', async () => {
    // Patch a project-tier field; verify previously-saved fields stay
    // intact. (Machine-tier fields like `daemon.log_level`, `capture.*`,
    // `notifications.*` are silently dropped from the project file by
    // ProjectConfigSchema — that's covered separately in tier-dispatch tests.)
    await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { release_provenance: { production_debug_include_unknown: false } },
    });
    const saved = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8')) as {
      release_provenance?: { production_debug_include_unknown?: boolean };
    };
    expect(saved.release_provenance?.production_debug_include_unknown).toBe(false);
    // Verify another project-tier section is preserved
    const merged = YAML.parse(fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8'));
    expect(merged.version).toBe(3);
  });

  it('PUT scoped returns 400 for missing patch', async () => {
    const result = await handlePutScopedConfig(vaultDir, { scope: 'project' });
    expect(result.status).toBe(400);
  });

  it('PUT scoped returns 400 for schema-invalid patch', async () => {
    const result = await handlePutScopedConfig(vaultDir, {
      scope: 'project',
      patch: { embedding: { provider: 'invalid-provider' } },
    });
    expect(result.status).toBe(400);
  });

  describe('GET /api/config/merged — served-treeless degrade (Task C-6 item 1)', () => {
    it('degrades to machine+grove tiers instead of throwing when the project root has no myco.yaml on this machine', async () => {
      // A Team Host operator browsing a served member project's Settings
      // page over localhost: `vaultDir`'s parent (the project root) exists
      // nowhere on this machine at all — the member's checkout, not this
      // one. Before the fix, `loadMergedConfig` here had no
      // `projectTierOptional`, so this threw "myco.yaml not found" and the
      // request 500'd instead of rendering machine+grove-tier settings.
      const treelessVaultDir = path.join(
        os.tmpdir(),
        `myco-config-merged-treeless-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        '.myco',
      );
      // Deliberately never created on disk — this IS the treeless case.
      expect(fs.existsSync(path.dirname(treelessVaultDir))).toBe(false);

      const result = await handleGetMergedConfig(treelessVaultDir, { groveId: null });

      expect(result.status ?? 200).toBe(200);
      const body = result.body as { version: number };
      // The merge still succeeds — machine+grove tiers (here, both empty)
      // plus the schema defaults, not a thrown error.
      expect(body.version).toBeGreaterThan(0);
    });
  });
});
