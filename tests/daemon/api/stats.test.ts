import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handleGetStats, computeConfigHash, type StatsHandlerDeps } from '@myco/daemon/api/stats';
import { MycoIndex } from '@myco/index/sqlite';
import { initFts } from '@myco/index/fts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

function makeConfig() {
  return {
    version: 2 as const,
    config_version: 0,
    intelligence: {
      llm: { provider: 'ollama' as const, model: 'test', context_window: 8192, max_tokens: 1024 },
      embedding: { provider: 'ollama' as const, model: 'bge-m3' },
    },
    daemon: { port: null, log_level: 'info' as const, grace_period: 30, max_log_size: 5242880 },
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
    team: { enabled: false, user: '', sync: 'git' as const },
    digest: {
      enabled: true,
      tiers: [1500, 3000, 5000, 7500, 10000],
      inject_tier: 3000,
      intelligence: { provider: null, model: null, base_url: null, context_window: 32768, keep_alive: '30m', gpu_kv_cache: false },
      metabolism: { active_interval: 900, cooldown_intervals: [1800, 3600, 7200], dormancy_threshold: 14400 },
      substrate: { max_notes_per_cycle: 50 },
    },
  };
}

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

  it('returns stats with spec-compliant nested shape', async () => {
    const configHash = computeConfigHash(vaultDir);
    const deps: StatsHandlerDeps = {
      vaultDir, index, vectorIndex: null, version: '1.2.3',
      config: makeConfig(), configHash,
    };

    const result = await handleGetStats(deps);
    const body = result.body as Record<string, unknown>;

    // Daemon fields nested under daemon
    const daemon = body.daemon as Record<string, unknown>;
    expect(daemon.version).toBe('1.2.3');
    expect(typeof daemon.uptime_seconds).toBe('number');
    expect(daemon.config_hash).toBe(configHash);
    expect(daemon.config_hash).toHaveLength(32); // MD5 hex

    // Intelligence uses processor/digest/embedding per spec
    const intel = body.intelligence as Record<string, unknown>;
    expect(intel.processor).toEqual({ provider: 'ollama', model: 'test' });
    expect(intel.digest).toBeNull(); // No digest provider configured
    expect(intel.embedding).toEqual({ provider: 'ollama', model: 'bge-m3' });
  });

  it('includes digest state when metabolism is provided', async () => {
    const metabolism = { state: 'active' as const, currentIntervalMs: 300000 };
    const configHash = computeConfigHash(vaultDir);
    const deps: StatsHandlerDeps = {
      vaultDir, index, vectorIndex: null, version: '1.0.0',
      config: makeConfig(), configHash, metabolism: metabolism as any,
    };

    const result = await handleGetStats(deps);
    const body = result.body as Record<string, unknown>;

    const digest = body.digest as Record<string, unknown>;
    expect(digest.enabled).toBe(true);
    expect(digest.metabolism_state).toBe('active');
  });
});
