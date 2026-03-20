import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProgressTracker } from '@myco/daemon/api/progress';
import { handleRebuild, handleDigest, handleCurate } from '@myco/daemon/api/operations';
import type { OperationHandlerDeps } from '@myco/daemon/api/operations';
import type { MycoConfig } from '@myco/config/schema';
import type { MycoIndex } from '@myco/index/sqlite';
import type { VectorIndex } from '@myco/index/vectors';
import type { LlmProvider, EmbeddingProvider } from '@myco/intelligence/llm';
import type { CurationDeps, CurationResult } from '@myco/services/vault-ops';

// --- Test helpers ---

function makeConfig(overrides?: { digestEnabled?: boolean }): MycoConfig {
  return {
    version: 2,
    intelligence: {
      llm: { provider: 'ollama', model: 'test', context_window: 8192, max_tokens: 1024 },
      embedding: { provider: 'ollama', model: 'test-embed' },
    },
    daemon: { log_level: 'info', grace_period: 30, max_log_size: 5_242_880 },
    capture: { transcript_paths: [], artifact_watch: [], artifact_extensions: ['.md'], buffer_max_events: 500 },
    context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, spores: 300, team: 200 } },
    team: { enabled: false, user: '', sync: 'git' },
    digest: {
      enabled: overrides?.digestEnabled ?? true,
      tiers: [1500, 3000, 5000, 10000],
      inject_tier: 3000,
      intelligence: {
        provider: null,
        model: null,
        base_url: null,
        context_window: 32768,
      },
      metabolism: {
        active_interval: 300,
        cooldown_intervals: [900, 1800, 3600],
        dormancy_threshold: 7200,
      },
      substrate: {
        max_notes_per_cycle: 50,
      },
    },
  } as MycoConfig;
}

function makeMockIndex(): MycoIndex {
  return {
    query: vi.fn().mockReturnValue([]),
    getNoteByPath: vi.fn(),
    upsertNote: vi.fn(),
    deleteNote: vi.fn(),
    queryByIds: vi.fn(),
    close: vi.fn(),
    getPragma: vi.fn(),
    getDb: vi.fn(),
  } as unknown as MycoIndex;
}

function makeMockLlm(): LlmProvider {
  return {
    name: 'test',
    summarize: vi.fn().mockResolvedValue({ text: 'test', model: 'test-model' }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function makeMockEmbedding(): EmbeddingProvider {
  return {
    name: 'test',
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2], model: 'test', dimensions: 2 }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function makeDeps(overrides?: Partial<OperationHandlerDeps>): OperationHandlerDeps {
  return {
    vaultDir: '/tmp/test-vault',
    config: makeConfig(),
    index: makeMockIndex(),
    vectorIndex: null,
    llmProvider: makeMockLlm(),
    embeddingProvider: makeMockEmbedding(),
    progressTracker: new ProgressTracker(),
    log: vi.fn(),
    ...overrides,
  };
}

// --- Tests ---

describe('handleRebuild', () => {
  it('creates a progress token and returns it', async () => {
    const deps = makeDeps();
    const result = await handleRebuild(deps);
    const body = result.body as Record<string, unknown>;

    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
  });

  it('returns same token if rebuild is already running', async () => {
    const deps = makeDeps();
    const result1 = await handleRebuild(deps);
    const result2 = await handleRebuild(deps);

    const body1 = result1.body as Record<string, unknown>;
    const body2 = result2.body as Record<string, unknown>;
    expect(body1.token).toBe(body2.token);
  });

  it('progress entry exists after handler returns', async () => {
    const deps = makeDeps();
    const result = await handleRebuild(deps);
    const body = result.body as Record<string, unknown>;
    const entry = deps.progressTracker.get(body.token as string);

    expect(entry).toBeDefined();
    expect(entry!.type).toBe('rebuild');
    expect(entry!.status).toBe('running');
  });
});

describe('handleDigest', () => {
  it('creates a progress token for valid request', async () => {
    const deps = makeDeps();
    const result = await handleDigest(deps, {});
    const body = result.body as Record<string, unknown>;

    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
  });

  it('returns 400 when digest is disabled', async () => {
    const deps = makeDeps({ config: makeConfig({ digestEnabled: false }) });
    const result = await handleDigest(deps, {});

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('digest_disabled');
  });

  it('returns 400 for invalid body', async () => {
    const deps = makeDeps();
    const result = await handleDigest(deps, { tier: 'not-a-number' });

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('validation_failed');
  });

  it('accepts tier as a number', async () => {
    const deps = makeDeps();
    const result = await handleDigest(deps, { tier: 3000 });
    const body = result.body as Record<string, unknown>;

    expect(body.token).toBeDefined();
    expect(result.status).toBeUndefined(); // 200 default
  });

  it('accepts full flag', async () => {
    const deps = makeDeps();
    const result = await handleDigest(deps, { full: true });
    const body = result.body as Record<string, unknown>;

    expect(body.token).toBeDefined();
    expect(result.status).toBeUndefined();
  });
});

describe('handleCurate', () => {
  let mockRunCuration: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRunCuration = vi.fn().mockResolvedValue({
      scanned: 10,
      clustersEvaluated: 3,
      superseded: 2,
    } satisfies CurationResult);
  });

  it('dry-run returns results synchronously', async () => {
    const deps = makeDeps({
      vectorIndex: { close: vi.fn() } as unknown as VectorIndex,
    });
    const result = await handleCurate(deps, { dry_run: true }, mockRunCuration);

    expect(result.status).toBeUndefined();
    const body = result.body as Record<string, unknown>;
    expect(body.dry_run).toBe(true);
    expect(body.scanned).toBe(10);
    expect(body.clustersEvaluated).toBe(3);
    expect(body.superseded).toBe(2);

    // Verify runCuration was called with dryRun=true
    expect(mockRunCuration).toHaveBeenCalledWith(
      expect.objectContaining({ vaultDir: '/tmp/test-vault' }),
      true,
    );
  });

  it('non-dry-run creates a progress token', async () => {
    const deps = makeDeps({
      vectorIndex: { close: vi.fn() } as unknown as VectorIndex,
    });
    const result = await handleCurate(deps, {}, mockRunCuration);
    const body = result.body as Record<string, unknown>;

    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
  });

  it('returns 400 when vector index is unavailable', async () => {
    const deps = makeDeps({ vectorIndex: null });
    const result = await handleCurate(deps, {}, mockRunCuration);

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('vector_index_unavailable');
  });

  it('returns 400 for invalid body', async () => {
    const deps = makeDeps({
      vectorIndex: { close: vi.fn() } as unknown as VectorIndex,
    });
    const result = await handleCurate(deps, { dry_run: 'not-a-bool' }, mockRunCuration);

    expect(result.status).toBe(400);
    expect((result.body as Record<string, unknown>).error).toBe('validation_failed');
  });

  it('returns 500 when dry-run curation throws', async () => {
    const deps = makeDeps({
      vectorIndex: { close: vi.fn() } as unknown as VectorIndex,
    });
    mockRunCuration.mockRejectedValue(new Error('LLM exploded'));

    const result = await handleCurate(deps, { dry_run: true }, mockRunCuration);

    expect(result.status).toBe(500);
    expect((result.body as Record<string, unknown>).error).toBe('curation_failed');
  });

  it('accepts undefined body (defaults to non-dry-run)', async () => {
    const deps = makeDeps({
      vectorIndex: { close: vi.fn() } as unknown as VectorIndex,
    });
    const result = await handleCurate(deps, undefined, mockRunCuration);
    const body = result.body as Record<string, unknown>;

    // Non-dry-run returns a progress token
    expect(body.token).toBeDefined();
  });
});
