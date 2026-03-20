import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

const CLI_PATH = path.resolve(__dirname, '../../dist/src/cli.js');

function runInit(cwd: string, args: string[] = []): string {
  return execFileSync('node', [CLI_PATH, 'init', ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, MYCO_VAULT_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('myco init', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-test-'));
    execFileSync('git', ['init', '-q'], { cwd: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates vault at default .myco/ location', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(testDir, '.myco', 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.myco', '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, '.myco', 'index.db'))).toBe(true);
  });

  it('creates all required subdirectories', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const dirs = ['sessions', 'plans', 'spores', 'artifacts', 'team', 'buffer', 'logs'];
    for (const dir of dirs) {
      expect(fs.existsSync(path.join(testDir, '.myco', dir))).toBe(true);
    }
  });

  it('writes valid v2 config with explicit values', () => {
    runInit(testDir, [
      '--llm-provider', 'ollama',
      '--llm-model', 'gpt-oss',
      '--embedding-provider', 'ollama',
      '--embedding-model', 'bge-m3',
      '--user', 'chris',
    ]);

    const yaml = fs.readFileSync(path.join(testDir, '.myco', 'myco.yaml'), 'utf-8');
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

  it('sets team mode when --team flag is passed', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3', '--team', '--user', 'chris']);

    const config = YAML.parse(fs.readFileSync(path.join(testDir, '.myco', 'myco.yaml'), 'utf-8'));
    expect(config.team.enabled).toBe(true);
    expect(config.team.user).toBe('chris');
  });

  it('uses correct base_url when explicitly passed', () => {
    runInit(testDir, ['--llm-provider', 'lm-studio', '--llm-model', 'test', '--llm-url', 'http://localhost:1234', '--embedding-model', 'bge-m3', '--embedding-url', 'http://localhost:11434']);

    const config = YAML.parse(fs.readFileSync(path.join(testDir, '.myco', 'myco.yaml'), 'utf-8'));
    expect(config.intelligence.llm.base_url).toBe('http://localhost:1234');
    expect(config.intelligence.embedding.base_url).toBe('http://localhost:11434');
  });

  it('accepts custom --vault path', () => {
    const customVault = path.join(testDir, 'custom-vault');
    runInit(testDir, ['--vault', customVault, '--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    expect(fs.existsSync(path.join(customVault, 'myco.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(customVault, 'sessions'))).toBe(true);
  });

  it('writes .gitignore excluding runtime artifacts', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const gitignore = fs.readFileSync(path.join(testDir, '.myco', '.gitignore'), 'utf-8');
    expect(gitignore).toContain('index.db');
    expect(gitignore).toContain('vectors.db');
    expect(gitignore).toContain('daemon.json');
    expect(gitignore).toContain('buffer/');
    expect(gitignore).toContain('logs/');
    expect(gitignore).toContain('.obsidian/');
  });

  it('is idempotent — does not overwrite existing vault', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3', '--user', 'alice']);

    // Modify config to prove it's not overwritten
    const configPath = path.join(testDir, '.myco', 'myco.yaml');
    const original = fs.readFileSync(configPath, 'utf-8');

    const output = runInit(testDir, ['--llm-provider', 'lm-studio', '--llm-model', 'other', '--embedding-model', 'other', '--user', 'bob']);

    expect(output).toContain('already initialized');
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('includes artifact_watch for both Claude and Cursor plan dirs', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(testDir, '.myco', 'myco.yaml'), 'utf-8'));
    expect(config.capture.artifact_watch).toContain('.claude/plans/');
    expect(config.capture.artifact_watch).toContain('.cursor/plans/');
  });

  it('accepts custom --llm-url override', () => {
    runInit(testDir, ['--llm-provider', 'ollama', '--llm-model', 'gpt-oss', '--llm-url', 'http://gpu-box:11434', '--embedding-model', 'bge-m3']);

    const config = YAML.parse(fs.readFileSync(path.join(testDir, '.myco', 'myco.yaml'), 'utf-8'));
    expect(config.intelligence.llm.base_url).toBe('http://gpu-box:11434');
  });
});
