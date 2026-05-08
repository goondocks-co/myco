import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

mock.module('@myco/services/stats.js', () => ({
  gatherStats: vi.fn(),
}));

import { gatherStats } from '@myco/services/stats.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove } from '@myco/grove/registry.js';
import { computeConfigHash, createLiveStatsHandler, resolveStatsContext } from '@myco/daemon/api/stats.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import type { RouteRequest } from '@myco/daemon/router.js';

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/api/stats',
    ...overrides,
  };
}

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

    const requestContext = resolveLegacyRequestContext('/tmp/live-vault', {
      projectRoot: '/tmp/live-project',
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: 'grove-a',
      machineId: 'machine-a',
      sessionId: 'sess-a',
      source: 'explicit',
    });
    requestContext.databasePath = '/tmp/grove-a/myco.db';

    const result = await handler(makeReq({
      requestContext,
    }));
    const body = result.body as {
      daemon: {
        pid: number;
        port: number;
        version: string;
        uptime_seconds: number;
      };
      context: {
        project: { id: string; name: string; root: string };
        grove: { id: string | null; connection_state: string };
        request: { source: string; project_id: string; grove_id: string | null };
      };
      config_hash: string;
    };

    expect(gatherStats).toHaveBeenCalledWith('/tmp/live-vault', {
      active_sessions: ['sess-1', 'sess-2'],
      scope: { kind: 'project', id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(body.daemon.pid).toBe(process.pid);
    expect(body.daemon.port).toBe(18765);
    expect(body.daemon.version).toBe('1.2.3');
    expect(body.daemon.uptime_seconds).toBe(42);
    expect(body.context.project.id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(body.context.project.root).toBe('/tmp/live-project');
    expect(body.context.grove.id).toBe('grove-a');
    expect(body.context.grove.connection_state).toBe('pending');
    expect(body.context.request.source).toBe('explicit');
    expect(body.context.request.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(body.context.request.grove_id).toBe('grove-a');
    expect(body.config_hash).toBe('abc123');
  });

});

describe('resolveStatsContext', () => {
  let testDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stats-context-'));
    previousHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, 'home');
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousHome;
    }
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves registered Grove and project manifest context for status visibility', () => {
    const vaultDir = path.join(testDir, 'project', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const grove = createGrove('Work', process.env.MYCO_HOME!);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'status-project' },
      grove: { binding_id: 'gbind_status', slug: grove.slug, mode: 'local' },
    });

    const context = resolveStatsContext(vaultDir, resolveLegacyRequestContext(vaultDir, {
      projectRoot: path.dirname(vaultDir),
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: grove.id,
      machineId: 'machine-a',
      source: 'explicit',
    }));

    expect(context.project).toEqual({
      id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'status-project',
      root: path.dirname(vaultDir),
      manifest_state: 'present',
    });
    expect(context.grove).toMatchObject({
      id: grove.id,
      name: 'Work',
      slug: 'work',
      binding_id: 'gbind_status',
      connection_state: 'local-only',
    });
    expect(context.request.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(context.request.grove_id).toBe(grove.id);
  });
});
