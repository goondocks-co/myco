import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

vi.mock('@myco/services/stats.js', () => ({
  gatherStats: vi.fn(),
}));

import { gatherStats } from '@myco/services/stats.js';
import { computeConfigHash, createLiveStatsHandler } from '@myco/daemon/api/stats.js';

describe('computeConfigHash', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the md5 of myco.yaml contents', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-hash-'));
    try {
      const raw = 'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n';
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), raw, 'utf-8');

      expect(computeConfigHash(vaultDir)).toBe(
        createHash('md5').update(raw).digest('hex'),
      );
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('returns an empty string when the config file is missing', () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-hash-missing-'));
    try {
      expect(computeConfigHash(vaultDir)).toBe('');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });
});

describe('createLiveStatsHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('overlays live daemon fields onto gathered stats and returns config_hash', async () => {
    vi.mocked(gatherStats).mockReturnValue({
      daemon: {
        pid: 1,
        port: 2,
        version: 'stale',
        uptime_seconds: 0,
        active_sessions: [],
      },
      vault: {
        path: '/tmp/old-vault',
        name: 'old-vault',
        session_count: 1,
        batch_count: 2,
        spore_count: 3,
        plan_count: 4,
        artifact_count: 5,
        entity_count: 0,
        edge_count: 0,
      },
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
        queue_depth: 6,
        embedded_count: 7,
        total_embeddable: 13,
      },
      agent: {
        last_run_at: 100,
        last_run_status: 'completed',
        total_runs: 8,
      },
      digest: {
        freshest_tier: 5000,
        generated_at: 200,
        tiers_available: [1500, 5000],
      },
      unprocessed_batches: 9,
    });

    vi.spyOn(process, 'uptime').mockReturnValue(42.9);

    const handler = createLiveStatsHandler({
      vaultDir: '/tmp/live-vault',
      registry: { sessions: ['sess-1', 'sess-2'] },
      server: { port: 18765, version: '1.2.3' },
      configHash: { get: () => 'abc123' },
    });

    const result = await handler();
    const body = result.body as {
      daemon: {
        pid: number;
        port: number;
        version: string;
        uptime_seconds: number;
      };
      config_hash: string;
    };

    expect(gatherStats).toHaveBeenCalledWith('/tmp/live-vault', {
      active_sessions: ['sess-1', 'sess-2'],
    });
    expect(body.daemon.pid).toBe(process.pid);
    expect(body.daemon.port).toBe(18765);
    expect(body.daemon.version).toBe('1.2.3');
    expect(body.daemon.uptime_seconds).toBe(42);
    expect(body.config_hash).toBe('abc123');
  });
});
