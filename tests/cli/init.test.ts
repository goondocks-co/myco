import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

// Mock SQLite database layer — avoid native extension dependency in tests
const { mockDb } = vi.hoisted(() => {
  const mockDb = {};
  return { mockDb };
});

mock.module('@myco/db/client.js', () => ({
  initDatabase: vi.fn().mockReturnValue(mockDb),
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

mock.module('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn(),
  resolveProjectRoot: vi.fn((vaultDir: string) => path.dirname(vaultDir)),
}));

import { run } from '@myco/cli/init.js';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { resolveVaultDir } from '@myco/vault/resolve.js';

describe('myco init', () => {
  let testDir: string;
  let vault: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-test-'));
    vault = path.join(testDir, '.myco');
    vi.clearAllMocks();
    vi.mocked(resolveVaultDir).mockReturnValue(vault);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates vault with config and gitignore', async () => {
    await run(['--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(vault, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.gitignore'))).toBe(true);
  });

  it('initializes SQLite database', async () => {
    await run(['--embedding-model', 'bge-m3']);

    expect(initDatabase).toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalled();
  });

  it('creates all required subdirectories', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const dirs = ['buffer', 'attachments', 'logs'];
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(vault, dir))).toBe(true);
    }
  });

  it('writes valid v3 config with explicit values', async () => {
    await run([
      '--embedding-provider', 'ollama',
      '--embedding-model', 'bge-m3',
    ]);

    const yaml = fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8');
    const config = YAML.parse(yaml);

    expect(config.version).toBe(3);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('bge-m3');
    expect(config.daemon.log_level).toBe('info');
    expect(config.capture.artifact_extensions).toEqual(['.md']);
  });

  it('uses correct base_url when explicitly passed', async () => {
    await run(['--embedding-model', 'bge-m3', '--embedding-url', 'http://localhost:11434']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.embedding.base_url).toBe('http://localhost:11434');
  });

  it('writes .gitignore excluding runtime artifacts', async () => {
    await run(['--embedding-model', 'bge-m3']);

    const gitignore = fs.readFileSync(path.join(vault, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('myco.db');
    expect(gitignore).toContain('daemon.json');
    expect(gitignore).toContain('buffer/');
    expect(gitignore).toContain('logs/');
    expect(gitignore).toContain('attachments/');
    expect(gitignore).toContain('runtime/');
    expect(gitignore).toContain('runtime.tmp/');
  });

  it('is idempotent — does not overwrite user-set values on re-init', async () => {
    await run(['--embedding-model', 'bge-m3', '--non-interactive']);

    const configPath = path.join(vault, 'myco.yaml');
    const originalEmbedding = YAML.parse(fs.readFileSync(configPath, 'utf-8')).embedding.model;
    expect(originalEmbedding).toBe('bge-m3');

    // Second init with a different embedding model must NOT overwrite the
    // user's stored choice. (The file text itself may change — e.g. the
    // config-version migration runs on re-read — but the user's selections
    // stay put.)
    const consoleSpy = vi.spyOn(console, 'log');
    await run(['--embedding-model', 'other', '--non-interactive']);

    const afterEmbedding = YAML.parse(fs.readFileSync(configPath, 'utf-8')).embedding.model;
    expect(afterEmbedding).toBe('bge-m3');
    consoleSpy.mockRestore();
  });

  it('leaves agent toggles at their schema default (true) — init no longer scaffolds them as false', async () => {
    // Regression: init used to explicitly write scheduled_tasks_enabled=false
    // and event_tasks_enabled=false into myco.yaml. Combined with the daemon
    // reading project-only config, this meant the scheduler never ran on a
    // fresh install even when the user enabled the toggles at personal scope.
    await run(['--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.agent.scheduled_tasks_enabled).toBe(true);
    expect(config.agent.event_tasks_enabled).toBe(true);
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
