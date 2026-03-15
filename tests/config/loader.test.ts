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

  it('loads valid v2 config', () => {
    const yaml = `version: 2
intelligence:
  llm:
    provider: ollama
    model: gpt-oss
  embedding:
    provider: ollama
    model: bge-m3
`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(2);
    expect(config.intelligence.llm.provider).toBe('ollama');
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

  it('auto-maps haiku provider to anthropic', () => {
    const yaml = `version: 2
intelligence:
  llm:
    provider: haiku
    model: claude-haiku-4-5-20251001
  embedding:
    provider: ollama
    model: bge-m3
`;
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.intelligence.llm.provider).toBe('anthropic');
  });

  it('saves v2 config with validation', () => {
    const config = {
      version: 2 as const,
      intelligence: {
        llm: { provider: 'ollama' as const, model: 'gpt-oss', context_window: 8192, max_tokens: 1024 },
        embedding: { provider: 'ollama' as const, model: 'bge-m3' },
      },
      capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: ['.md'], buffer_max_events: 500 },
      context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, memories: 300, team: 200 } },
      daemon: { log_level: 'info' as const, grace_period: 30, max_log_size: 5242880 },
      team: { enabled: false, user: '', sync: 'git' as const },
    };
    saveConfig(tmpDir, config);
    const loaded = loadConfig(tmpDir);
    expect(loaded.intelligence.llm.provider).toBe('ollama');
  });
});
