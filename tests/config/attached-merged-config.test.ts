/**
 * Tests for `loadAttachedMergedConfig` — the member-side per-tier config carve
 * for an attached project (routing-layer §6.3).
 *
 * Hermetic: a fresh tmp `mycoHome` (machine tier) and a fresh tmp vault
 * (project + personal tiers) per test, both passed explicitly so no developer
 * `~/.myco` is touched. The grove tier is sourced through an injectable
 * `fetchGroveDoc` seam — a fixture stands in for the host, and a spy proves the
 * machine tier never triggers a host fetch.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import {
  loadAttachedMergedConfig,
  loadMergedConfig,
  saveGroveConfig,
} from '@myco/config/loader';
import { GroveConfigSchema } from '@myco/config/schema';

let mycoHome: string;
let vaultDir: string;

function writeMachineConfig(doc: Record<string, unknown>): void {
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.writeFileSync(path.join(mycoHome, 'config.yaml'), YAML.stringify(doc), 'utf-8');
}

function writeProjectConfig(doc: Record<string, unknown>): void {
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify({ version: 3, ...doc }), 'utf-8');
}

function writeLocalConfig(doc: Record<string, unknown>): void {
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'local.yaml'), YAML.stringify(doc), 'utf-8');
}

beforeEach(() => {
  mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attached-home-'));
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-attached-vault-'));
});

afterEach(() => {
  fs.rmSync(mycoHome, { recursive: true, force: true });
  fs.rmSync(vaultDir, { recursive: true, force: true });
});

describe('loadAttachedMergedConfig', () => {
  test('machine tier resolves from local disk — never via the host fetch seam', async () => {
    writeMachineConfig({ daemon: { log_level: 'debug' } });
    writeProjectConfig({});

    let fetchCalls = 0;
    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => {
        fetchCalls += 1;
        return {}; // grove tier — the ONLY tier that consults the host
      },
    });

    // The machine value is present AND it came from local disk: the fetch seam
    // fired exactly once (for the grove tier), never for the machine tier.
    expect(config.daemon.log_level).toBe('debug');
    expect(fetchCalls).toBe(1);
  });

  test('grove tier comes from the fixture host', async () => {
    writeMachineConfig({});
    writeProjectConfig({});

    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => ({ embedding: { provider: 'openai', model: 'text-embedding-3-small' } }),
    });

    expect(config.embedding.provider).toBe('openai');
    expect(config.embedding.model).toBe('text-embedding-3-small');
  });

  test('four-tier precedence: machine + grove(host) + project + personal, local wins where it may override', async () => {
    writeMachineConfig({ daemon: { log_level: 'warn' } });          // machine-homed
    writeProjectConfig({ cortex: { enabled: false } });             // project-homed
    writeLocalConfig({ skills: { confidence_threshold: 0.9 } });    // grove-homed, local-overridable

    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => ({
        embedding: { provider: 'openrouter' },  // grove-homed
        skills: { confidence_threshold: 0.5 },  // grove default, overridden by local below
      }),
    });

    expect(config.daemon.log_level).toBe('warn');           // machine tier
    expect(config.embedding.provider).toBe('openrouter');   // grove tier (host)
    expect(config.cortex.enabled).toBe(false);              // project tier
    expect(config.skills.confidence_threshold).toBe(0.9);   // personal overrides grove
  });

  test('host-unreachable: grove tier degrades to defaults, other tiers intact, onGroveUnreachable fires once', async () => {
    writeMachineConfig({ daemon: { log_level: 'error' } });
    writeProjectConfig({ cortex: { enabled: false } });

    const unreachable: unknown[] = [];
    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => {
        throw new Error('overlay unreachable');
      },
      onGroveUnreachable: (err) => unreachable.push(err),
    });

    // Grove-tier field falls back to its schema default (provider 'ollama')...
    expect(config.embedding.provider).toBe('ollama');
    // ...while machine + project tiers still resolve locally.
    expect(config.daemon.log_level).toBe('error');
    expect(config.cortex.enabled).toBe(false);
    expect(unreachable.length).toBe(1);
    expect((unreachable[0] as Error).message).toBe('overlay unreachable');
  });

  test('fetchGroveDoc returning null degrades identically to a throw', async () => {
    writeMachineConfig({});
    writeProjectConfig({});

    let warned = 0;
    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => null,
      onGroveUnreachable: () => { warned += 1; },
    });

    expect(config.embedding.provider).toBe('ollama'); // grove default
    expect(warned).toBe(1);
  });

  test('equivalent to loadMergedConfig with the same grove doc on disk (assembly is not a fork)', async () => {
    // Prove the carve composes the SAME merge as loadMergedConfig: given the
    // same four tiers — with the grove tier on local disk for loadMergedConfig
    // and host-sourced for loadAttachedMergedConfig — the merged result matches.
    const groveId = 'grove_0123456789abcdef0123456789abcdef';
    writeMachineConfig({ daemon: { log_level: 'debug' } });
    writeProjectConfig({ cortex: { enabled: false } });
    writeLocalConfig({ skills: { confidence_threshold: 0.8 } });

    const groveDoc = GroveConfigSchema.parse({
      embedding: { provider: 'openai' },
      skills: { confidence_threshold: 0.4 },
    }) as unknown as Record<string, unknown>;
    saveGroveConfig(groveId, groveDoc as never, mycoHome);

    const local = loadMergedConfig(vaultDir, { groveId, mycoHome });
    const attached = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => groveDoc,
    });

    expect(attached).toEqual(local);
  });

  test('an ABSENT project myco.yaml is tolerated — project tier contributes defaults, no throw', async () => {
    // Fresh clone-then-attach: the working tree exists but `.myco/myco.yaml`
    // does not. Behave like loadMergedConfig's projectTierOptional path — the
    // project tier stands in with just `version`, machine + grove still resolve.
    writeMachineConfig({ daemon: { log_level: 'debug' } });
    // Deliberately NO writeProjectConfig — the file is absent.

    const config = await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => ({ embedding: { provider: 'openai' } }),
    });

    expect(config.version).toBe(3);
    expect(config.daemon.log_level).toBe('debug');   // machine tier, local disk
    expect(config.embedding.provider).toBe('openai'); // grove tier, host-sourced
    expect(config.cortex.enabled).toBe(true);        // project tier absent → default
    // Never materialized a myco.yaml for the member.
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(false);
  });

  test('a PRESENT-but-malformed project myco.yaml still throws (corruption ≠ absence)', async () => {
    writeMachineConfig({});
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'foo: [1, 2\n', 'utf-8');

    await expect(
      loadAttachedMergedConfig(vaultDir, {
        mycoHome,
        fetchGroveDoc: async () => ({}),
      }),
    ).rejects.toThrow();
  });

  test('grove-tier residue in myco.yaml never materializes a local grove config file', async () => {
    // A project myco.yaml carrying a stray grove-tier leaf must NOT be migrated
    // into a local grove config file for the hosted Grove (never-materialize).
    writeMachineConfig({});
    writeProjectConfig({ embedding: { provider: 'openai' } }); // grove-tier residue in project file

    await loadAttachedMergedConfig(vaultDir, {
      mycoHome,
      fetchGroveDoc: async () => ({ embedding: { provider: 'ollama' } }),
    });

    // No grove config directory/file should have been written under mycoHome.
    const grovesDir = path.join(mycoHome, 'groves');
    const wroteGroveConfig = fs.existsSync(grovesDir)
      && fs.readdirSync(grovesDir).some((entry) => {
        const cfg = path.join(grovesDir, entry, 'config.yaml');
        return fs.existsSync(cfg);
      });
    expect(wroteGroveConfig).toBe(false);
  });
});
