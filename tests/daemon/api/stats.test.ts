import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleGetStats, type StatsHandlerDeps } from '@myco/daemon/api/stats';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

describe('stats API', () => {
  let vaultDir: string;
  let index: MycoIndex;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-api-'));
    const config = { version: 2, intelligence: { llm: { provider: 'ollama', model: 'test' } } };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    index = new MycoIndex(path.join(vaultDir, 'index.db'));
    initFts(index);
  });

  afterEach(() => {
    index.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns stats with daemon runtime fields', async () => {
    const deps: StatsHandlerDeps = {
      vaultDir,
      index,
      vectorIndex: null,
      version: '1.2.3',
      config: {
        version: 2,
        config_version: 0,
        intelligence: {
          llm: { provider: 'ollama', model: 'test', context_window: 8192, max_tokens: 1024 },
          embedding: { provider: 'ollama', model: 'bge-m3' },
        },
        daemon: { port: null, log_level: 'info', grace_period: 30, max_log_size: 5242880 },
        capture: {
          transcript_paths: [],
          artifact_watch: [],
          artifact_extensions: ['.md'],
          buffer_max_events: 500,
          extraction_max_tokens: 2048,
          summary_max_tokens: 1024,
          title_max_tokens: 32,
          classification_max_tokens: 1024,
        },
        context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, spores: 300, team: 200 } },
        team: { enabled: false, user: '', sync: 'git' },
        digest: {
          enabled: true,
          tiers: [1500, 3000, 5000, 10000],
          inject_tier: 3000,
          intelligence: { provider: null, model: null, base_url: null, context_window: 32768, keep_alive: '30m', gpu_kv_cache: false },
          metabolism: { active_interval: 300, cooldown_intervals: [900, 1800, 3600], dormancy_threshold: 7200 },
          substrate: { max_notes_per_cycle: 50 },
        },
      },
    };

    const result = await handleGetStats(deps);
    const body = result.body as Record<string, unknown>;

    expect(body).toHaveProperty('version', '1.2.3');
    expect(body).toHaveProperty('uptime_seconds');
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body).toHaveProperty('config_hash');
    expect(typeof body.config_hash).toBe('string');
    expect((body.config_hash as string).length).toBe(32); // MD5 hex length
    expect(body).toHaveProperty('intelligence');
    expect((body.intelligence as Record<string, unknown>).llm).toEqual({ provider: 'ollama', model: 'test' });
  });

  it('includes digest state when metabolism is provided', async () => {
    // Minimal metabolism-like object
    const metabolism = { state: 'active' as const, currentIntervalMs: 300000 };
    const deps: StatsHandlerDeps = {
      vaultDir,
      index,
      vectorIndex: null,
      version: '1.0.0',
      config: {
        version: 2,
        config_version: 0,
        intelligence: {
          llm: { provider: 'ollama', model: 'test', context_window: 8192, max_tokens: 1024 },
          embedding: { provider: 'ollama', model: 'bge-m3' },
        },
        daemon: { port: null, log_level: 'info', grace_period: 30, max_log_size: 5242880 },
        capture: {
          transcript_paths: [],
          artifact_watch: [],
          artifact_extensions: ['.md'],
          buffer_max_events: 500,
          extraction_max_tokens: 2048,
          summary_max_tokens: 1024,
          title_max_tokens: 32,
          classification_max_tokens: 1024,
        },
        context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, spores: 300, team: 200 } },
        team: { enabled: false, user: '', sync: 'git' },
        digest: {
          enabled: true,
          tiers: [1500, 3000, 5000, 10000],
          inject_tier: 3000,
          intelligence: { provider: null, model: null, base_url: null, context_window: 32768, keep_alive: '30m', gpu_kv_cache: false },
          metabolism: { active_interval: 300, cooldown_intervals: [900, 1800, 3600], dormancy_threshold: 7200 },
          substrate: { max_notes_per_cycle: 50 },
        },
      },
      metabolism: metabolism as any,
    };

    const result = await handleGetStats(deps);
    const body = result.body as Record<string, unknown>;

    expect(body).toHaveProperty('digest');
    const digest = body.digest as Record<string, unknown>;
    expect(digest.metabolism_state).toBe('active');
    expect(digest.interval_ms).toBe(300000);
  });
});
