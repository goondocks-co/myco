import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';

// Mock SQLite database layer — avoid native extension dependency in tests
const { mockDb } = vi.hoisted(() => {
  const mockDb = {};
  return { mockDb };
});

mock.module('@myco/db/client.js', () => ({
  initDatabase: vi.fn().mockReturnValue(mockDb),
  openDatabase: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ version: 32 }),
    }),
    run: vi.fn(),
    close: vi.fn(),
  }),
  vaultDbPath: vi.fn((dir: string) => `${dir}/myco.db`),
  closeDatabase: vi.fn(),
}));
mock.module('@myco/db/schema.js', () => ({
  createSchema: vi.fn(),
  SCHEMA_VERSION: 1,
  EMBEDDING_DIMENSIONS: 1024,
}));

// Prevent init from detecting real symbionts and running registration in tests
mock.module('@myco/symbionts/detect.js', () => ({
  detectSymbionts: vi.fn().mockReturnValue([]),
  loadManifests: vi.fn().mockReturnValue([]),
  resolvePackageRoot: vi.fn().mockReturnValue('/tmp'),
}));
mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    async ensureRunning() {
      return false;
    }
  },
}));

class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(`unsafe: ${reason}`);
  }
}
mock.module('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn(),
  resolveProjectRoot: vi.fn((vaultDir: string) => path.dirname(vaultDir)),
  // Test vaults sit in /tmp/myco-init-*, which the real guard would
  // accept — stub the assertion as a no-op so we don't have to thread
  // safe-path fixtures through every test case.
  assertSafeProjectRoot: vi.fn(),
  UnsafeProjectRootError,
}));

import { run } from '@myco/cli/init.js';
import { initDatabase, openDatabase, closeDatabase } from '@myco/db/client.js';
import { resolveVaultDir } from '@myco/vault/resolve.js';
import { loadGroveConfig } from '@myco/config/loader.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';

describe('myco init', () => {
  let testDir: string;
  let vault: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-test-'));
    vault = path.join(testDir, '.myco');
    process.env.MYCO_HOME = path.join(testDir, '.home');
    vi.clearAllMocks();
    vi.mocked(resolveVaultDir).mockReturnValue(vault);
  });

  afterEach(() => {
    delete process.env.MYCO_HOME;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('prints help without initializing or updating a project', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await run(['--help']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: myco init'));
    expect(fs.existsSync(vault)).toBe(false);
    expect(openDatabase).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('creates vault with config and gitignore', async () => {
    await run(['--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(vault, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vault, 'project.toml'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.gitignore'))).toBe(true);
  });

  it('does not create a legacy vault-local myco.db', async () => {
    await run(['--embedding-model', 'bge-m3']);

    // Post-Grove projects route DB access through the Grove DB at
    // ~/.myco/groves/<id>/myco.db. A vault-local myco.db at .myco/myco.db
    // is never read by any post-Grove code path; its presence trips
    // ensureGroveActivation's legacy-detection heuristic on the next
    // `myco update`, causing a false migration attempt.
    expect(fs.existsSync(path.join(vault, 'myco.db'))).toBe(false);
    expect(initDatabase).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
    // Grove database is still initialized (openDatabase, not initDatabase)
    expect(openDatabase).toHaveBeenCalled();
  });

  it('initializes the Grove database under the global Myco home', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const groveDbCall = vi.mocked(openDatabase).mock.calls.find(([dbPath]) =>
      typeof dbPath === 'string' && dbPath.includes(`${path.sep}groves${path.sep}`),
    );

    expect(groveDbCall?.[0]).toEndWith(path.join('myco.db'));
    expect(groveDbCall?.[0]).toContain(process.env.MYCO_HOME!);
  });

  it('creates all required subdirectories', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const dirs = ['buffer', 'attachments', 'logs', 'migration', 'tasks'];
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(vault, dir))).toBe(true);
    }
  });

  it('writes project manifest and registers into the default Grove', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const manifest = parseToml(fs.readFileSync(path.join(vault, 'project.toml'), 'utf-8')) as Record<string, any>;
    expect(manifest.project.id).toStartWith('proj_');
    expect(manifest.grove.id).toStartWith('grove_');
    expect(manifest.grove.slug).toBe('default');
    expect(manifest.grove.name).toBe('default');
    expect(manifest.grove.binding_id).toBeUndefined();
    expect(manifest.grove.mode).toBeUndefined();
    const localManifest = parseToml(fs.readFileSync(path.join(vault, 'project.local.toml'), 'utf-8')) as Record<string, any>;
    expect(localManifest.grove_binding.binding_id).toStartWith('gbind_');
    expect(localManifest.grove_binding.mode).toBe('local');

    // Filter to directory entries — `~/.myco/groves/` also holds the
    // top-level `registry.yaml` file (Grove registry pointer).
    const grovesDir = path.join(process.env.MYCO_HOME!, 'groves');
    const groveIds = fs.readdirSync(grovesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(groveIds).toHaveLength(1);
    expect(fs.existsSync(path.join(grovesDir, groveIds[0], 'registry', 'projects.toml'))).toBe(true);
  });

  it('honors --project and --grove for explicit project registration', async () => {
    const home = process.env.MYCO_HOME!;
    const { createGrove } = await import('@myco/grove/registry.js');
    createGrove('Work', home);
    const target = path.join(testDir, 'target-project');
    fs.mkdirSync(target, { recursive: true });

    await run(['--project', target, '--grove', 'work', '--embedding-model', 'bge-m3', '--non-interactive']);

    const targetVault = path.join(target, '.myco');
    const manifest = parseToml(fs.readFileSync(path.join(targetVault, 'project.toml'), 'utf-8')) as Record<string, any>;
    expect(manifest.grove.id).toStartWith('grove_');
    expect(manifest.grove.slug).toBe('work');
    expect(manifest.grove.name).toBe('Work');
    expect(fs.existsSync(path.join(targetVault, 'myco.yaml'))).toBe(true);
  });

  it('rejects an unknown --grove before creating a partial vault', async () => {
    const target = path.join(testDir, 'unknown-grove-project');
    fs.mkdirSync(target, { recursive: true });

    await expect(run([
      '--project', target,
      '--grove', 'does-not-exist',
      '--embedding-model', 'bge-m3',
      '--non-interactive',
    ])).rejects.toThrow(/Unknown Grove: does-not-exist/);

    expect(fs.existsSync(path.join(target, '.myco'))).toBe(false);
    expect(initDatabase).not.toHaveBeenCalled();
  });

  it('rejects --grove when project.toml is already bound to another Grove', async () => {
    const home = process.env.MYCO_HOME!;
    const { createGrove, registerProjectInGrove } = await import('@myco/grove/registry.js');
    const { saveProjectManifest } = await import('@myco/config/project-manifest.js');
    const work = createGrove('Work', home);
    createGrove('Other', home);
    fs.mkdirSync(vault, { recursive: true });
    saveProjectManifest(vault, {
      project: { id: 'proj_bound', name: 'bound-project' },
      grove: { binding_id: 'gbind_bound', slug: work.slug, mode: 'local' },
    });
    registerProjectInGrove(work.id, {
      projectId: 'proj_bound',
      projectName: 'bound-project',
      projectRoot: testDir,
      bindingId: 'gbind_bound',
    }, home);

    await expect(run(['--grove', 'other', '--non-interactive']))
      .rejects.toThrow(/belongs to Grove Work/);

    expect(initDatabase).not.toHaveBeenCalled();
  });

  it('writes valid v3 config with explicit values', async () => {
    await run([
      '--embedding-provider', 'ollama',
      '--embedding-model', 'bge-m3',
    ]);

    const yaml = fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8');
    const config = YAML.parse(yaml);

    expect(config.version).toBe(3);
    // embedding is now Grove-tier; ProjectConfigSchema strips it from project file
    expect(config.embedding).toBeUndefined();
    expect(config.capture.artifact_extensions).toEqual(['.md']);
    // `daemon.log_level` is machine-tier now (~/.myco/config.yaml);
    // ProjectConfigSchema strips it from project myco.yaml on save.
    expect(config.daemon).toBeUndefined();
  });

  it('uses correct base_url when explicitly passed', async () => {
    await run(['--embedding-model', 'bge-m3', '--embedding-url', 'http://localhost:11434']);

    const groveId = loadProjectManifest(vault)?.grove?.id;
    expect(groveId).toBeDefined();
    const groveConfig = loadGroveConfig(groveId!);
    expect(groveConfig.embedding.base_url).toBe('http://localhost:11434');
  });

  it('is idempotent — does not overwrite user-set values on re-init', async () => {
    await run(['--embedding-model', 'bge-m3', '--non-interactive']);

    const groveId = loadProjectManifest(vault)?.grove?.id;
    expect(groveId).toBeDefined();
    const originalModel = loadGroveConfig(groveId!).embedding.model;
    expect(originalModel).toBe('bge-m3');

    // Second init with a different embedding model must NOT overwrite the
    // user's stored choice — the idempotency guard at `hasEmbeddingFlags &&
    // !alreadyInitialized` prevents it.
    const consoleSpy = vi.spyOn(console, 'log');
    await run(['--embedding-model', 'other', '--non-interactive']);

    const afterModel = loadGroveConfig(groveId!).embedding.model;
    expect(afterModel).toBe('bge-m3');
    consoleSpy.mockRestore();
  });

  it('writes .gitignore excluding runtime artifacts', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const gitignore = fs.readFileSync(path.join(vault, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('myco.db');
    expect(gitignore).toContain('daemon.json');
    expect(gitignore).toContain('buffer/');
    expect(gitignore).toContain('logs/');
    expect(gitignore).toContain('attachments/');
    expect(gitignore).toContain('migration/');
    // Project-scope runtime pin (written by `make dev-link`) is per-machine
    // and must not be committed. The legacy machine-scope `runtime/` and
    // `runtime.tmp/` directories don't live under .myco/ — they're at
    // `~/.myco/` — and never need a project-level gitignore entry.
    expect(gitignore).toContain('runtime.command');
    expect(gitignore).not.toContain('runtime.tmp/');
  });

  it('initializes plan_dirs as empty array (agent-specific dirs come from symbiont manifests)', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.capture.plan_dirs).toEqual([]);
  });

  it('persists symbiont selection to config when manifests provided', async () => {
    const { loadManifests, detectSymbionts } = await import('@myco/symbionts/detect.js');
    vi.mocked(loadManifests).mockReturnValue([
      { name: 'claude-code', displayName: 'Claude Code', binary: 'claude', configDir: '.claude',
        pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
        hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' } },
    ]);
    vi.mocked(detectSymbionts).mockReturnValue([
      { manifest: vi.mocked(loadManifests)()[0], binaryFound: true, configDirFound: false },
    ]);

    // --non-interactive so init doesn't open the inquirer checkbox when
    // stdin is a TTY (which it is on some dev terminals even under
    // `bun test`). Without it, init hangs waiting for the prompt.
    await run(['--embedding-model', 'bge-m3', '--non-interactive']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.symbionts).toBeDefined();
    expect(config.symbionts['claude-code']).toEqual({ enabled: true });
  });
});
