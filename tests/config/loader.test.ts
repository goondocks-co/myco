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

  it('loads valid config from myco.yaml', () => {
    const yaml = 'version: 1\nintelligence:\n  backend: local\n';
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(1);
    expect(config.intelligence.backend).toBe('local');
  });

  it('throws on missing config file', () => {
    expect(() => loadConfig(tmpDir)).toThrow(/myco\.yaml not found/);
  });

  it('throws on invalid config', () => {
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), 'version: 2\n');
    expect(() => loadConfig(tmpDir)).toThrow();
  });

  it('saves config with validation', () => {
    const config = {
      version: 1 as const,
      intelligence: { backend: 'cloud' as const },
      capture: { transcript_paths: [], artifact_watch: [], buffer_max_events: 500 },
      context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, memories: 300, team: 200 } },
      team: { enabled: false, user: '', sync: 'git' as const },
    };
    saveConfig(tmpDir, config);
    const loaded = loadConfig(tmpDir);
    expect(loaded.intelligence.backend).toBe('cloud');
  });

  it('rejects invalid config on save', () => {
    const bad = { version: 99 } as any;
    expect(() => saveConfig(tmpDir, bad)).toThrow();
  });
});
