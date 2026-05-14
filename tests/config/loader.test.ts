import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, saveConfig, updateConfig } from '@myco/config/loader';
import {
  invalidateMergedConfigCache,
  loadLocalConfig,
  loadMergedConfig,
  saveLocalConfig,
  updateLocalConfig,
} from '@myco/config/loader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Config Loader', () => {
  let tmpDir: string;
  let mycoHomeDir: string;
  let previousMycoHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-'));
    // Sandbox the machine + grove config writes during tier-strip migration
    // — without this, loadConfig would clobber the developer's real ~/.myco/config.yaml.
    mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHomeDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHomeDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
  });

  it('loads valid v3 config', () => {
    const yaml = `version: 3
embedding:
  provider: ollama
  model: bge-m3
`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(3);
    expect(config.embedding.provider).toBe('ollama');
  });

  it('throws on missing config file', () => {
    expect(() => loadConfig(tmpDir)).toThrow(/myco\.yaml not found/);
  });

  it('throws migration error for v1 config', () => {
    const yaml = 'version: 1\nintelligence:\n  backend: local\n';
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    expect(() => loadConfig(tmpDir)).toThrow(/v1 format.*setup-llm/);
  });

  it('throws migration error when intelligence.backend is present', () => {
    const yaml = 'version: 1\nintelligence:\n  backend: cloud\n';
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    expect(() => loadConfig(tmpDir)).toThrow(/v1 format/);
  });

  it('migrates v2 config to v3 extracting embedding', () => {
    const yaml = `version: 2
intelligence:
  llm:
    provider: ollama
    model: qwen3.5
  embedding:
    provider: ollama
    model: bge-m3
daemon:
  port: 7432
  log_level: debug
  grace_period: 30
  max_log_size: 5242880
capture:
  transcript_paths: []
  artifact_watch:
    - .claude/plans/
  artifact_extensions:
    - .md
  buffer_max_events: 500
  extraction_max_tokens: 2048
context:
  max_tokens: 1200
team:
  enabled: false
  user: chris
digest:
  enabled: true
`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    // Opt into the three-tier strip so we can assert the moved Machine fields.
    loadConfig(tmpDir, { migrateTiers: true });
    const machineYaml = fs.readFileSync(path.join(mycoHomeDir, 'config.yaml'), 'utf-8');
    // daemon.port is no longer migrated — the canonical port is derived
    // from the service path; the v2 override is silently dropped.
    expect(machineYaml).not.toContain('port:');
    expect(machineYaml).toContain('log_level: debug');
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.version).toBe(3);
    expect(reloaded.embedding.provider).toBe('ollama');
    expect(reloaded.embedding.model).toBe('bge-m3');
    const raw = reloaded as Record<string, unknown>;
    expect(raw.intelligence).toBeUndefined();
    expect(raw.digest).toBeUndefined();
  });

  it('v2 migration maps lm-studio embedding to openai-compatible', () => {
    const yaml = `version: 2
intelligence:
  llm:
    provider: ollama
    model: qwen3.5
  embedding:
    provider: lm-studio
    model: bge-m3
`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(3);
    expect(config.embedding.provider).toBe('openai-compatible');
  });

  it('updateConfig applies transform and persists', () => {
    const yaml = `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);

    const result = updateConfig(tmpDir, (config) => ({
      ...config,
      embedding: { ...config.embedding, model: 'nomic-embed-text' },
    }));

    expect(result.embedding.model).toBe('nomic-embed-text');

    // Verify it was persisted to disk
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.embedding.model).toBe('nomic-embed-text');
  });

  it('updateConfig rejects invalid transforms without writing', () => {
    const yaml = `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);

    expect(() =>
      updateConfig(tmpDir, (config) => ({
        ...config,
        version: 99 as never,
      })),
    ).toThrow();

    // Original file should be untouched
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.embedding.model).toBe('bge-m3');
  });

  it('saves v3 config with validation', () => {
    const config = {
      version: 3 as const,
      config_version: 0,
      embedding: { provider: 'ollama' as const, model: 'bge-m3' },
      capture: { transcript_paths: [], plan_dirs: [], artifact_extensions: ['.md'], buffer_max_events: 500 },
      daemon: { port: null, log_level: 'info' as const },
    };
    saveConfig(tmpDir, config);
    const loaded = loadConfig(tmpDir);
    expect(loaded.embedding.provider).toBe('ollama');
  });

  it('does not serialize Grove-tier defaults into project config', () => {
    const config = loadConfig(writeMinimalProject(tmpDir));

    saveConfig(tmpDir, config);

    const written = fs.readFileSync(path.join(tmpDir, 'myco.yaml'), 'utf-8');
    expect(written).not.toContain('run_in_deep_sleep');
    expect(written).not.toContain('scheduled_tasks_active_window_days');
  });
});

function writeProject(dir: string, yaml: string) {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), yaml);
}
function writeMinimalProject(dir: string) {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), 'version: 3\n');
  return dir;
}
function writeLocal(dir: string, yaml: string) {
  // Tests treat `dir` as the vault directory (matches resolveVaultDir's `.myco/` convention).
  // local.yaml sits directly inside the vault, alongside myco.yaml — no extra `.myco/` prefix.
  fs.writeFileSync(path.join(dir, 'local.yaml'), yaml);
}

describe('Local config overlay', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-overlay-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('loadLocalConfig returns {} when file missing', () => {
    expect(loadLocalConfig(tmpDir)).toEqual({});
  });

  it('loadLocalConfig returns {} when file empty', () => {
    writeLocal(tmpDir, '');
    expect(loadLocalConfig(tmpDir)).toEqual({});
  });

  it('loadMergedConfig overlays local onto project at leaf', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n  mode: dark\n`);
    writeLocal(tmpDir, `appearance:\n  theme: moss\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.appearance.theme).toBe('moss');
    expect(merged.appearance.mode).toBe('dark');
  });

  it('loadMergedConfig returns project unchanged when no local', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.appearance.theme).toBe('sage');
  });

  it('saveLocalConfig creates local.yaml and deep-merges', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    saveLocalConfig(tmpDir, { appearance: { theme: 'plum' } });
    saveLocalConfig(tmpDir, { appearance: { font: 'geist-mono' } });
    const local = loadLocalConfig(tmpDir);
    expect(local.appearance).toEqual({ theme: 'plum', font: 'geist-mono' });
  });

  it('updateLocalConfig round-trips through callback', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    updateLocalConfig(tmpDir, (local) => ({ ...local, appearance: { ...local.appearance, theme: 'dusk' } }));
    expect(loadLocalConfig(tmpDir).appearance?.theme).toBe('dusk');
  });

  it('merged-array policy: local arrays replace project arrays', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\ncapture:\n  plan_dirs: ['a', 'b']\n`);
    writeLocal(tmpDir, `capture:\n  plan_dirs: ['c']\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.capture.plan_dirs).toEqual(['c']);
  });

  it('loadLocalConfig returns {} and warns when YAML is malformed', () => {
    writeLocal(tmpDir, 'appearance: {\n  theme: "unterminated');
    // loadLocalConfig should not throw
    expect(loadLocalConfig(tmpDir)).toEqual({});
  });

  it('loadLocalConfig returns {} when YAML root is a scalar', () => {
    writeLocal(tmpDir, 'sage');
    expect(loadLocalConfig(tmpDir)).toEqual({});
  });

  it('loadLocalConfig returns {} when YAML root is an array', () => {
    writeLocal(tmpDir, '- a\n- b\n');
    expect(loadLocalConfig(tmpDir)).toEqual({});
  });
});

describe('loadMergedConfig caching', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cache-'));
    invalidateMergedConfigCache();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateMergedConfigCache();
  });

  it('returns the same object reference on a back-to-back call', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n`);
    const first = loadMergedConfig(tmpDir);
    const second = loadMergedConfig(tmpDir);
    expect(second).toBe(first);
  });

  it('reloads when myco.yaml changes on disk', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n`);
    const first = loadMergedConfig(tmpDir);
    expect(first.appearance.theme).toBe('sage');

    // Bump mtime + content to invalidate the fingerprint deterministically.
    const next = `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: moss\n`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), next);
    fs.utimesSync(path.join(tmpDir, 'myco.yaml'), new Date(), new Date(Date.now() + 2000));

    const second = loadMergedConfig(tmpDir);
    expect(second.appearance.theme).toBe('moss');
    expect(second).not.toBe(first);
  });

  it('reloads when local.yaml is added', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n`);
    const first = loadMergedConfig(tmpDir);
    expect(first.appearance.theme).toBe('sage');

    writeLocal(tmpDir, `appearance:\n  theme: moss\n`);
    const second = loadMergedConfig(tmpDir);
    expect(second.appearance.theme).toBe('moss');
    expect(second).not.toBe(first);
  });

  it('saveLocalConfig invalidates the cached merge', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nappearance:\n  theme: sage\n`);
    loadMergedConfig(tmpDir);
    saveLocalConfig(tmpDir, { appearance: { theme: 'plum' } });
    expect(loadMergedConfig(tmpDir).appearance.theme).toBe('plum');
  });
});
