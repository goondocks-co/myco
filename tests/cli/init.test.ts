import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

// Mock PGlite database layer — avoid native extension dependency in tests
const { mockDb } = vi.hoisted(() => {
  const mockDb = {};
  return { mockDb };
});

vi.mock('@myco/db/client.js', () => ({
  initDatabase: vi.fn().mockResolvedValue(mockDb),
  initDatabaseForVault: vi.fn().mockResolvedValue(mockDb),
  closeDatabase: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@myco/db/schema.js', () => ({
  createSchema: vi.fn().mockResolvedValue(undefined),
  SCHEMA_VERSION: 1,
  EMBEDDING_DIMENSIONS: 1024,
}));

// Prevent tests from modifying .claude/settings.json when vault is outside project root
vi.mock('@myco/cli/shared.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@myco/cli/shared.js')>();
  return { ...actual, configureVaultEnv: vi.fn() };
});

import { run } from '@myco/cli/init.js';
import { initDatabaseForVault, closeDatabase } from '@myco/db/client.js';

describe('myco init', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates vault with config and gitignore', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(vault, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(vault, '.gitignore'))).toBe(true);
  });

  it('initializes PGlite database in pgdata/', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    expect(initDatabaseForVault).toHaveBeenCalledWith(vault);
    expect(closeDatabase).toHaveBeenCalled();
  });

  it('creates all required subdirectories', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const dirs = ['sessions', 'plans', 'spores', 'artifacts', 'team', 'buffer', 'logs'];
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(vault, dir))).toBe(true);
    }
  });

  it('writes valid v2 config with explicit values', async () => {
    const vault = path.join(testDir, 'vault');
    await run([
      '--vault', vault,
      '--llm-provider', 'ollama',
      '--llm-model', 'gpt-oss',
      '--embedding-provider', 'ollama',
      '--embedding-model', 'bge-m3',
      '--user', 'chris',
    ]);

    const yaml = fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8');
    const config = YAML.parse(yaml);

    expect(config.version).toBe(2);
    expect(config.intelligence.llm.provider).toBe('ollama');
    expect(config.intelligence.llm.model).toBe('gpt-oss');
    expect(config.intelligence.llm.context_window).toBe(8192);
    expect(config.intelligence.llm.max_tokens).toBe(1024);
    expect(config.intelligence.embedding.provider).toBe('ollama');
    expect(config.intelligence.embedding.model).toBe('bge-m3');
    expect(config.daemon.log_level).toBe('info');
    expect(config.daemon.grace_period).toBe(30);
    expect(config.capture.artifact_extensions).toEqual(['.md']);
    expect(config.team.user).toBe('chris');
    expect(config.team.enabled).toBe(false);
  });

  it('sets team mode when --team flag is passed', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3', '--team', '--user', 'chris']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.team.enabled).toBe(true);
    expect(config.team.user).toBe('chris');
  });

  it('uses correct base_url when explicitly passed', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'lm-studio', '--llm-model', 'test', '--llm-url', 'http://localhost:1234', '--embedding-model', 'bge-m3', '--embedding-url', 'http://localhost:11434']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.intelligence.llm.base_url).toBe('http://localhost:1234');
    expect(config.intelligence.embedding.base_url).toBe('http://localhost:11434');
  });

  it('accepts custom --vault path', async () => {
    const customVault = path.join(testDir, 'custom-vault');
    await run(['--vault', customVault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(customVault, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(customVault, 'sessions'))).toBe(true);
  });

  it('writes .gitignore excluding runtime artifacts', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const gitignore = fs.readFileSync(path.join(vault, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('pgdata/');
    expect(gitignore).toContain('daemon.json');
    expect(gitignore).toContain('buffer/');
    expect(gitignore).toContain('logs/');
    expect(gitignore).toContain('.obsidian/');
  });

  it('is idempotent — does not overwrite existing vault', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3', '--user', 'alice']);

    // Capture the original config to prove it is not overwritten
    const configPath = path.join(vault, 'myco.yaml');
    const original = fs.readFileSync(configPath, 'utf-8');

    // Second init should detect existing vault and return early
    const consoleSpy = vi.spyOn(console, 'log');
    await run(['--vault', vault, '--llm-provider', 'lm-studio', '--llm-model', 'other', '--embedding-model', 'other', '--user', 'bob']);

    const loggedMessages = consoleSpy.mock.calls.map(c => c[0]);
    expect(loggedMessages.some((m: string) => m.includes('already initialized'))).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    consoleSpy.mockRestore();
  });

  it('includes artifact_watch for both Claude and Cursor plan dirs', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.capture.artifact_watch).toContain('.claude/plans/');
    expect(config.capture.artifact_watch).toContain('.cursor/plans/');
  });

  it('accepts custom --llm-url override', async () => {
    const vault = path.join(testDir, 'vault');
    await run(['--vault', vault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--llm-url', 'http://gpu-box:11434', '--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.intelligence.llm.base_url).toBe('http://gpu-box:11434');
  });
});
