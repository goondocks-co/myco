import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadConfig, saveConfig, updateConfig } from '@myco/config/loader';
import {
  invalidateMergedConfigCache,
  loadLocalConfig,
  loadMergedConfig,
  saveLocalConfig,
  updateLocalConfig,
} from '@myco/config/loader';
import { clearProjectManifestCache } from '@myco/config/project-manifest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

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
    // daemon.port is a machine-tier override set directly in config.yaml; the
    // legacy v2 value is NOT carried forward (it defaults to null = derive), so
    // a stale port can't surprise the daemon. The field itself parses again.
    expect(machineYaml).not.toContain('7432');
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

  it('updateConfig applies transform and persists (project-tier field)', () => {
    // capture.* moved to Machine tier (2026-06 scope correction), so it's no
    // longer a project-file field. Use a project-tier field
    // (release_provenance.*) to exercise the same updateConfig→saveConfig
    // round-trip against myco.yaml.
    const yaml = `version: 3\nrelease_provenance:\n  enabled: true\n`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);

    const result = updateConfig(tmpDir, (config) => ({
      ...config,
      release_provenance: { ...config.release_provenance, enabled: false },
    }));

    expect(result.release_provenance.enabled).toBe(false);

    // Verify it was persisted to disk
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.release_provenance.enabled).toBe(false);
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

  it('loadMergedConfig overlays local onto project at leaf for project-scoped fields', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n`);
    writeLocal(tmpDir, `notifications:\n  enabled: false\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.notifications.enabled).toBe(false);
  });

  it('loadMergedConfig returns project unchanged when no local', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.appearance.theme).toBe('sage');
  });

  it('saveLocalConfig creates local.yaml and deep-merges project-local fields', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    saveLocalConfig(tmpDir, { notifications: { enabled: false } });
    saveLocalConfig(tmpDir, { notifications: { default_mode: 'banner' } });
    const local = loadLocalConfig(tmpDir);
    expect(local.notifications).toEqual({ enabled: false, default_mode: 'banner' });
  });

  it('updateLocalConfig round-trips through callback', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n`);
    updateLocalConfig(tmpDir, (local) => ({ ...local, notifications: { ...local.notifications, enabled: false } }));
    expect(loadLocalConfig(tmpDir).notifications?.enabled).toBe(false);
  });

  it('loadLocalConfig preserves legacy appearance until a Grove-aware migration can lift it', () => {
    writeLocal(tmpDir, `appearance:\n  theme: moss\nnotifications:\n  enabled: false\n`);
    const local = loadLocalConfig(tmpDir);
    expect(local.appearance?.theme).toBe('moss');
    expect(local.notifications?.enabled).toBe(false);
  });

  it('merged-array policy: local arrays replace project arrays', () => {
    // cortex.canopy.exclude.patterns is project-home + local-overridable
    // (scope registry), so both tiers survive the scope-aware prune and the
    // arrayStrategy:'replace' merge applies. (release_provenance.* and
    // capture.* are locked now, so neither can carry this assertion; the
    // user-additive canopy `patterns` array is the genuine project+local case.)
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\ncortex:\n  canopy:\n    exclude:\n      patterns: ['a', 'b']\n`);
    writeLocal(tmpDir, `cortex:\n  canopy:\n    exclude:\n      patterns: ['c']\n`);
    const merged = loadMergedConfig(tmpDir);
    expect(merged.cortex.canopy.exclude.patterns).toEqual(['c']);
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

describe('Grove-tier promotion — merge verification', () => {
  let tmpDir: string;
  let mycoHomeDir: string;
  let previousMycoHome: string | undefined;
  // Valid Grove-era id: grove_<32 hex chars>
  const groveId = 'grove_' + 'a'.repeat(32);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-merge-'));
    mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-grove-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHomeDir;
    invalidateMergedConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHomeDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
    invalidateMergedConfigCache();
  });

  function writeGroveConfig(groveYaml: string): void {
    const groveDir = path.join(mycoHomeDir, 'groves', groveId);
    fs.mkdirSync(groveDir, { recursive: true });
    fs.writeFileSync(path.join(groveDir, 'grove.yaml'), groveYaml);
  }

  it('Grove-tier agent.model reaches merged config', () => {
    writeMinimalProject(tmpDir);
    writeGroveConfig('agent:\n  model: claude-haiku-4-5\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.agent.model).toBe('claude-haiku-4-5');
  });

  it('Grove-tier embedding.provider and model reach merged config', () => {
    writeMinimalProject(tmpDir);
    writeGroveConfig('embedding:\n  provider: ollama\n  model: nomic-embed-text\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('nomic-embed-text');
  });

  it('Grove-tier appearance reaches merged config', () => {
    writeMinimalProject(tmpDir);
    writeGroveConfig('appearance:\n  theme: plum\n  mode: light\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.appearance.theme).toBe('plum');
    expect(config.appearance.mode).toBe('light');
  });

  it('legacy project appearance is lifted to Grove config and stripped from myco.yaml', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(tmpDir, `version: 3\nappearance:\n  theme: dusk\n`);

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.appearance.theme).toBe('dusk');
    const groveRaw = YAML.parse(fs.readFileSync(path.join(mycoHomeDir, 'groves', groveId, 'grove.yaml'), 'utf-8')) as Record<string, unknown>;
    expect((groveRaw.appearance as Record<string, unknown>).theme).toBe('dusk');
    const projectRaw = YAML.parse(fs.readFileSync(mycoYamlPath, 'utf-8')) as Record<string, unknown>;
    expect(projectRaw.appearance).toBeUndefined();
  });

  it('legacy local appearance is lifted to Grove config and stripped from local.yaml', () => {
    writeMinimalProject(tmpDir);
    writeLocal(tmpDir, `appearance:\n  theme: terracotta\nnotifications:\n  enabled: false\n`);

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.appearance.theme).toBe('terracotta');
    const groveRaw = YAML.parse(fs.readFileSync(path.join(mycoHomeDir, 'groves', groveId, 'grove.yaml'), 'utf-8')) as Record<string, unknown>;
    expect((groveRaw.appearance as Record<string, unknown>).theme).toBe('terracotta');
    const localRaw = YAML.parse(fs.readFileSync(path.join(tmpDir, 'local.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(localRaw.appearance).toBeUndefined();
    expect((localRaw.notifications as Record<string, unknown>).enabled).toBe(false);
  });

  it('wipes legacy project-tier agent config when Grove-bound (merged + disk)', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    fs.writeFileSync(
      mycoYamlPath,
      'version: 3\nagent:\n  provider:\n    type: openrouter\n',
    );
    writeGroveConfig('agent:\n  provider:\n    type: anthropic\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    // Grove is the source of truth; the stale project value is ignored.
    expect(config.agent.provider).toEqual({ type: 'anthropic' });
    // The loader's tier write-back removes the agent block from myco.yaml.
    const rawOnDisk = YAML.parse(fs.readFileSync(mycoYamlPath, 'utf-8')) as Record<string, unknown>;
    expect(rawOnDisk.agent).toBeUndefined();
  });

  it('legacy project semantic_write_check_enabled is lifted to Grove config and stripped from myco.yaml', () => {
    // Task 5.3 residue-lift: GROVE_PROMOTED_FIELDS now includes
    // agent.semantic_write_check_enabled, so migrateLegacyProjectFields (run
    // by loadMergedConfig with migrateTiers: true on every cache-miss load)
    // lifts an explicit project-tier value into grove config.yaml the first
    // time this project loads post-upgrade, exactly like the other promoted
    // agent.* fields above.
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(tmpDir, 'version: 3\nagent:\n  semantic_write_check_enabled: true\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(config.agent.semantic_write_check_enabled).toBe(true);
    const groveRaw = YAML.parse(fs.readFileSync(path.join(mycoHomeDir, 'groves', groveId, 'grove.yaml'), 'utf-8')) as Record<string, unknown>;
    expect((groveRaw.agent as Record<string, unknown>).semantic_write_check_enabled).toBe(true);
    const projectRaw = YAML.parse(fs.readFileSync(mycoYamlPath, 'utf-8')) as Record<string, unknown>;
    expect(projectRaw.agent).toBeUndefined();
  });

  it('a grove-scoped field placed in the project tier is not honored in merged config (pruned)', () => {
    // Every myco-enabled project is Grove-bound; agent/skills are grove-scoped
    // and stripped from project myco.yaml. The old "no-Grove deferral" (keep a
    // grove-scoped field in myco.yaml until a Grove exists) is a dead scenario.
    // If a stale grove-scoped value somehow lands in the project tier, the
    // scope-aware merge must NOT let it override the Grove's value: the Grove
    // owns the field, so the Grove value wins and the project stray is dropped.
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    fs.writeFileSync(
      mycoYamlPath,
      'version: 3\nskills:\n  confidence_threshold: 0.31\n',
    );
    // Grove has its own explicit skills value — the authoritative grove-tier
    // owner. (This also pins the migration's relocation guard: with an explicit
    // grove value, the stale project field is stripped, not lifted.)
    writeGroveConfig('skills:\n  confidence_threshold: 0.55\n');

    const config = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    // Grove value wins; the project-tier stray (0.31) is never honored.
    expect(config.skills.confidence_threshold).toBeCloseTo(0.55);
  });
});

describe('loadMergedConfig caching', () => {
  let tmpDir: string;
  let mycoHomeDir: string;
  let previousMycoHome: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cache-'));
    // Sandbox MYCO_HOME: the tier-strip migration now relocates capture/
    // notifications to machine config, so without this the merge would write
    // into the developer's real ~/.myco/config.yaml.
    mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-cache-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHomeDir;
    invalidateMergedConfigCache();
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHomeDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    invalidateMergedConfigCache();
  });

  it('returns the same object reference on a back-to-back call', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nrelease_provenance:\n  enabled: true\n`);
    const first = loadMergedConfig(tmpDir);
    const second = loadMergedConfig(tmpDir);
    expect(second).toBe(first);
  });

  it('reloads when myco.yaml changes on disk', () => {
    // release_provenance.* is still a project-tier field (stays in myco.yaml),
    // so it's the right signal for "project file changed on disk".
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nrelease_provenance:\n  enabled: true\n`);
    const first = loadMergedConfig(tmpDir);
    expect(first.release_provenance.enabled).toBe(true);

    // Bump mtime + content to invalidate the fingerprint deterministically.
    const next = `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nrelease_provenance:\n  enabled: false\n`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), next);
    fs.utimesSync(path.join(tmpDir, 'myco.yaml'), new Date(), new Date(Date.now() + 2000));

    const second = loadMergedConfig(tmpDir);
    expect(second.release_provenance.enabled).toBe(false);
    expect(second).not.toBe(first);
  });

  it('reloads when local.yaml is added', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n`);
    const first = loadMergedConfig(tmpDir);
    expect(first.notifications.enabled).toBe(true);

    // local.yaml is the highest-precedence overlay and tier-agnostic, so a
    // notifications override there still wins over the migrated machine value.
    writeLocal(tmpDir, `notifications:\n  enabled: false\n`);
    const second = loadMergedConfig(tmpDir);
    expect(second.notifications.enabled).toBe(false);
    expect(second).not.toBe(first);
  });

  it('saveLocalConfig invalidates the cached merge', () => {
    writeProject(tmpDir, `version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\nnotifications:\n  enabled: true\n`);
    loadMergedConfig(tmpDir);
    saveLocalConfig(tmpDir, { notifications: { enabled: false } });
    expect(loadMergedConfig(tmpDir).notifications.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2026-06 settings-scope correction:
//   capture.*       PROJECT → MACHINE
//   notifications.* PROJECT → MACHINE
//   skills.*        PROJECT → GROVE
// The tier-strip migration must relocate planted project values to their new
// tier file, strip them from myco.yaml, and never re-commit them.
// ---------------------------------------------------------------------------
describe('Settings-scope correction (2026-06) — tier migration', () => {
  let tmpDir: string;
  let mycoHomeDir: string;
  let previousMycoHome: string | undefined;
  const groveId = 'grove_' + 'b'.repeat(32);

  function machinePath(): string {
    return path.join(mycoHomeDir, 'config.yaml');
  }
  function grovePath(): string {
    return path.join(mycoHomeDir, 'groves', groveId, 'grove.yaml');
  }
  function readYaml(p: string): Record<string, unknown> {
    return (YAML.parse(fs.readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
  }
  function bindGrove(dir: string, id: string): void {
    // Minimal project.toml that loadProjectManifest can resolve a grove.id from.
    fs.writeFileSync(
      path.join(dir, 'project.toml'),
      `[project]\nid = "proj_${'c'.repeat(32)}"\nname = "test"\n\n[grove]\nid = "${id}"\nslug = "test-grove"\nmode = "local"\n`,
    );
    clearProjectManifestCache();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-scope-'));
    mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-scope-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHomeDir;
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHomeDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    invalidateMergedConfigCache();
    clearProjectManifestCache();
  });

  it('moves planted capture.* from myco.yaml to machine config and strips it', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(
      tmpDir,
      `version: 3\ncapture:\n  buffer_max_events: 999\n  artifact_extensions:\n    - .md\n    - .py\n`,
    );

    const merged = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    // Value preserved in the merged view…
    expect(merged.capture.buffer_max_events).toBe(999);
    expect(merged.capture.artifact_extensions).toEqual(['.md', '.py']);

    // …relocated to machine config…
    const machineRaw = readYaml(machinePath());
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(999);

    // …and stripped from myco.yaml (no longer git-committed).
    const projectRaw = readYaml(mycoYamlPath);
    expect(projectRaw.capture).toBeUndefined();
  });

  it('moves planted notifications.* from myco.yaml to machine config and strips it', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(
      tmpDir,
      `version: 3\nnotifications:\n  enabled: false\n  default_mode: banner\n`,
    );

    const merged = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(merged.notifications.enabled).toBe(false);
    expect(merged.notifications.default_mode).toBe('banner');

    const machineRaw = readYaml(machinePath());
    expect((machineRaw.notifications as Record<string, unknown>).enabled).toBe(false);
    expect((machineRaw.notifications as Record<string, unknown>).default_mode).toBe('banner');

    const projectRaw = readYaml(mycoYamlPath);
    expect(projectRaw.notifications).toBeUndefined();
  });

  it('moves planted skills.* from myco.yaml to GROVE config and strips it (Grove bound)', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(
      tmpDir,
      `version: 3\nskills:\n  confidence_threshold: 0.42\n  usage_stale_days: 7\n`,
    );

    const merged = loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    expect(merged.skills.confidence_threshold).toBeCloseTo(0.42);
    expect(merged.skills.usage_stale_days).toBe(7);

    const groveRaw = readYaml(grovePath());
    expect((groveRaw.skills as Record<string, unknown>).confidence_threshold).toBeCloseTo(0.42);
    expect((groveRaw.skills as Record<string, unknown>).usage_stale_days).toBe(7);

    const projectRaw = readYaml(mycoYamlPath);
    expect(projectRaw.skills).toBeUndefined();
  });

  it('still moves capture/notifications to machine even when NO Grove is bound', () => {
    const mycoYamlPath = path.join(tmpDir, 'myco.yaml');
    writeProject(tmpDir, `version: 3\ncapture:\n  buffer_max_events: 250\nnotifications:\n  enabled: false\n`);

    loadMergedConfig(tmpDir, { groveId: null, mycoHome: mycoHomeDir });

    const machineRaw = readYaml(machinePath());
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(250);
    expect((machineRaw.notifications as Record<string, unknown>).enabled).toBe(false);

    const projectRaw = readYaml(mycoYamlPath);
    expect(projectRaw.capture).toBeUndefined();
    expect(projectRaw.notifications).toBeUndefined();
  });

  it('is idempotent and does not clobber an explicit machine value', () => {
    // Pre-seed an explicit machine notifications value the user set directly.
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(machinePath(), `notifications:\n  enabled: true\n`);
    writeProject(tmpDir, `version: 3\nnotifications:\n  enabled: false\n`);

    loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });

    // The explicit machine value wins; the project value is NOT moved over it.
    const machineRaw = readYaml(machinePath());
    expect((machineRaw.notifications as Record<string, unknown>).enabled).toBe(true);

    // Second load is a no-op (idempotent): machine value still true.
    invalidateMergedConfigCache();
    loadMergedConfig(tmpDir, { groveId, mycoHome: mycoHomeDir });
    const machineRaw2 = readYaml(machinePath());
    expect((machineRaw2.notifications as Record<string, unknown>).enabled).toBe(true);
  });

  it('saveConfig strips machine-tier blocks (capture/notifications) but DEFERS grove-tier skills when NO Grove is bound', () => {
    writeProject(tmpDir, 'version: 3\n');
    const config = loadConfig(tmpDir);

    // No project.toml / Grove binding → unbound project.
    saveConfig(tmpDir, {
      ...config,
      capture: { ...config.capture, buffer_max_events: 777 },
      notifications: { ...config.notifications, enabled: false },
      skills: { ...config.skills, confidence_threshold: 0.9 },
    });

    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    // Machine-tier: always strippable (loadMergedConfig migrates them every read).
    expect(persisted.capture).toBeUndefined();
    expect(persisted.notifications).toBeUndefined();
    // Grove-tier: deferred until a Grove is bound, so the user's value is NOT
    // dropped (it'd be neither kept nor migrated → silent revert to default).
    expect((persisted.skills as Record<string, unknown>)?.confidence_threshold).toBeCloseTo(0.9);
    // Project-tier fields still allowed.
    expect(persisted.version).toBe(3);
  });

  it('saveConfig strips grove-tier skills from myco.yaml when a Grove IS bound', () => {
    // Bound project: the load-path migration relocates skills to grove config,
    // so the save-path is free to strip it (no data loss — grove tier owns it).
    bindGrove(tmpDir, groveId);
    writeProject(tmpDir, 'version: 3\n');
    const config = loadConfig(tmpDir);

    saveConfig(tmpDir, {
      ...config,
      skills: { ...config.skills, confidence_threshold: 0.9 },
    });

    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    expect(persisted.skills).toBeUndefined();
    expect(persisted.version).toBe(3);
  });

  it('updateConfig does NOT drop capture/notifications on an un-migrated project (Fix #1 repro)', () => {
    // Data-loss repro: the project myco.yaml still carries capture.* and
    // notifications.* (never migrated — the load path that relocates them only
    // runs with migrateTiers=true, which updateConfig→loadConfig does NOT set).
    // An unrelated project-tier write goes through
    //   updateConfig → loadConfig (no migrateTiers) → saveConfig.
    // Before the fix, saveConfig's ProjectConfigSchema.parse unconditionally
    // stripped capture/notifications and wrote them NOWHERE: not kept in
    // myco.yaml (project tier), not relocated to machine config (relocation
    // only happened on the load path). The values were silently destroyed.
    writeProject(
      tmpDir,
      [
        'version: 3',
        'capture:',
        '  buffer_max_events: 888',
        '  artifact_extensions:',
        '    - .md',
        '    - .rs',
        'notifications:',
        '  enabled: false',
        '  default_mode: banner',
        'release_provenance:',
        '  enabled: true',
        '',
      ].join('\n'),
    );

    updateConfig(tmpDir, (config) => ({
      ...config,
      release_provenance: { ...config.release_provenance, enabled: false },
    }));

    // capture/notifications must NOT survive in myco.yaml (they're machine-tier
    // now — saveConfig still strips them) …
    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    expect(persisted.capture).toBeUndefined();
    expect(persisted.notifications).toBeUndefined();
    expect((persisted.release_provenance as Record<string, unknown>).enabled).toBe(false);

    // … but the values must be RELOCATED to machine config, never lost.
    const machineRaw = readYaml(machinePath());
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(888);
    expect((machineRaw.capture as Record<string, unknown>).artifact_extensions).toEqual(['.md', '.rs']);
    expect((machineRaw.notifications as Record<string, unknown>).enabled).toBe(false);
    expect((machineRaw.notifications as Record<string, unknown>).default_mode).toBe('banner');

    // And they remain the effective values on a subsequent merged read.
    const merged = loadMergedConfig(tmpDir, { groveId: null, mycoHome: mycoHomeDir });
    expect(merged.capture.buffer_max_events).toBe(888);
    expect(merged.notifications.enabled).toBe(false);
    expect(merged.notifications.default_mode).toBe('banner');
  });

  it('saveConfig machine relocation is leaf-wise: unchanged residue never clobbers an explicit machine leaf', () => {
    // RC-3 semantics: relocation merges LEAF-WISE into the machine doc, and a
    // leaf may overwrite an explicit machine value only when the caller
    // changed it in this save. Stale on-disk residue in myco.yaml is dropped
    // by the schema strip, not relocated over the machine's newer value.
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(
      machinePath(),
      'capture:\n  buffer_max_events: 111\n  transcript_paths:\n    - /machine/explicit\n',
    );
    writeProject(tmpDir, 'version: 3\ncapture:\n  buffer_max_events: 999\n');
    const config = loadConfig(tmpDir);

    saveConfig(tmpDir, config);

    const machineRaw = readYaml(machinePath());
    // Unchanged residue does not clobber the machine's explicit value.
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(111);
    // The machine-explicit sibling leaf survives — no block-level overwrite.
    expect((machineRaw.capture as Record<string, unknown>).transcript_paths).toEqual(['/machine/explicit']);
    // … and capture is still stripped from myco.yaml.
    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    expect(persisted.capture).toBeUndefined();
  });

  it('saveConfig machine relocation: a caller-changed leaf lands on machine config, siblings survive', () => {
    // A deliberate updateConfig write of a machine-homed leaf must actually
    // land (caller wins at leaf granularity), while machine-explicit sibling
    // leaves are never wiped by a section-level write.
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(
      machinePath(),
      'capture:\n  buffer_max_events: 111\n  transcript_paths:\n    - /machine/explicit\n',
    );
    writeProject(tmpDir, 'version: 3\n');

    updateConfig(tmpDir, (config) => ({
      ...config,
      capture: { ...config.capture, buffer_max_events: 999 },
    }));

    const machineRaw = readYaml(machinePath());
    // The caller-set value wins at its leaf.
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(999);
    // The machine-explicit sibling leaf survives.
    expect((machineRaw.capture as Record<string, unknown>).transcript_paths).toEqual(['/machine/explicit']);
    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    expect(persisted.capture).toBeUndefined();
  });

  it('saveConfig relocation never clobbers an explicit machine leaf with a default-valued one', () => {
    // A default-valued leaf is not "meaningful" — it must neither relocate
    // over an explicit machine value nor pollute the machine doc.
    fs.mkdirSync(path.dirname(machinePath()), { recursive: true });
    fs.writeFileSync(machinePath(), 'capture:\n  buffer_max_events: 111\n');
    // 500 is the schema default for buffer_max_events.
    writeProject(tmpDir, 'version: 3\ncapture:\n  buffer_max_events: 500\n');
    const config = loadConfig(tmpDir);

    saveConfig(tmpDir, config);

    const machineRaw = readYaml(machinePath());
    expect((machineRaw.capture as Record<string, unknown>).buffer_max_events).toBe(111);
    const persisted = readYaml(path.join(tmpDir, 'myco.yaml'));
    expect(persisted.capture).toBeUndefined();
  });
});
