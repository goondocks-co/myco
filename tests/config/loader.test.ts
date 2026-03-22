import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig } from '@myco/config/loader';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Config Loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(3);
    expect(config.embedding.provider).toBe('ollama');
    expect(config.embedding.model).toBe('bge-m3');
    expect(config.daemon.port).toBe(7432);
    expect(config.daemon.log_level).toBe('debug');
    // Removed fields should not be present
    const raw = config as Record<string, unknown>;
    expect(raw.intelligence).toBeUndefined();
    expect(raw.context).toBeUndefined();
    expect(raw.team).toBeUndefined();
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

  it('saves v3 config with validation', () => {
    const config = {
      version: 3 as const,
      config_version: 0,
      embedding: { provider: 'ollama' as const, model: 'bge-m3' },
      capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: ['.md'], buffer_max_events: 500 },
      daemon: { port: null, log_level: 'info' as const },
    };
    saveConfig(tmpDir, config);
    const loaded = loadConfig(tmpDir);
    expect(loaded.embedding.provider).toBe('ollama');
  });
});
