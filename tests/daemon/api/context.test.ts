import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema';
import type { MycoConfig } from '@myco/config/schema';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts';
import { insertSpore } from '@myco/db/queries/spores';
import { registerAgent } from '@myco/db/queries/agents';
import { createSessionContextHandler, createPromptContextHandler } from '@myco/daemon/api/context';
import type { ContextDeps } from '@myco/daemon/api/context';
import type { RouteRequest } from '@myco/daemon/router';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';
import type { DaemonLogger } from '@myco/daemon/logger';
import { DEFAULT_AGENT_ID } from '@myco/constants';
import { getDatabase } from '@myco/db/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(body: unknown): RouteRequest {
  return { params: {}, query: {}, body, pathname: '/context' };
}

function mockLogger(): DaemonLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as DaemonLogger;
}

function mockEmbeddingManager(overrides: Record<string, unknown> = {}): EmbeddingManager {
  return {
    embedQuery: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    searchVectors: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as EmbeddingManager;
}

function makeDeps(overrides: Partial<ContextDeps> = {}): ContextDeps {
  return {
    embeddingManager: mockEmbeddingManager(),
    logger: mockLogger(),
    config: MycoConfigSchema.parse({ version: 3 }),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<MycoConfig['context']> = {}): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3,
    context: overrides,
  });
}

const NOW = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Session context handler
// ---------------------------------------------------------------------------

describe('createSessionContextHandler', () => {
  beforeAll(() => {
    setupTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: NOW });
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    getDatabase().prepare('DELETE FROM digest_extracts').run();
  });

  it('returns basic context when no digest extract exists', async () => {
    const handler = createSessionContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'sess-1', branch: 'main' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('basic');
    expect(body.text).toContain('Branch:: `main`');
    expect(body.text).toContain('Session:: `sess-1`');
  });

  it('injects digest when extract exists', async () => {
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 5000,
      content: '# Project Intelligence\nThis is the digest content.',
      generated_at: NOW,
    });

    const handler = createSessionContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'sess-2', branch: 'main' }));
    const body = result.body as { text: string; source: string; tier?: number };

    expect(body.source).toBe('digest');
    expect(body.tier).toBe(5000);
    expect(body.text).toContain('# Project Intelligence');
    expect(body.text).toContain('Session:: `sess-2`');
  });

  it('uses configured tier', async () => {
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 3000,
      content: '# Tier 3000 digest',
      generated_at: NOW,
    });

    const handler = createSessionContextHandler(makeDeps({ config: makeConfig({ digest_tier: 3000 }) }));
    const result = await handler(makeReq({ session_id: 'sess-3' }));
    const body = result.body as { text: string; source: string; tier?: number };

    expect(body.source).toBe('digest');
    expect(body.tier).toBe(3000);
    expect(body.text).toContain('# Tier 3000 digest');
  });

  it('falls back to basic when configured tier has no extract', async () => {
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 5000,
      content: '# Wrong tier',
      generated_at: NOW,
    });

    const handler = createSessionContextHandler(makeDeps({ config: makeConfig({ digest_tier: 1500 }) }));
    const result = await handler(makeReq({ session_id: 'sess-4', branch: 'feat' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('basic');
    expect(body.text).not.toContain('# Wrong tier');
  });
});

// ---------------------------------------------------------------------------
// Prompt context handler
// ---------------------------------------------------------------------------

describe('createPromptContextHandler', () => {
  it('returns empty when prompt_search disabled', async () => {
    const handler = createPromptContextHandler(makeDeps({ config: makeConfig({ prompt_search: false }) }));
    const result = await handler(makeReq({ prompt: 'How should I handle auth?', session_id: 's-1' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty for short prompts', async () => {
    const handler = createPromptContextHandler(makeDeps());
    const result = await handler(makeReq({ prompt: 'hi', session_id: 's-2' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty when embedding provider unavailable', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({ embedQuery: vi.fn().mockResolvedValue(null) }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-3' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty when no search results', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({ searchVectors: vi.fn().mockReturnValue([]) }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-4' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty when max_spores is 0', async () => {
    const handler = createPromptContextHandler(makeDeps({ config: makeConfig({ prompt_max_spores: 0 }) }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-5' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('excludes superseded spores from results', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({
        searchVectors: vi.fn().mockReturnValue([
          { id: 'spore-1', namespace: 'spores', similarity: 0.8, metadata: { status: 'superseded', observation_type: 'gotcha' } },
          { id: 'spore-2', namespace: 'spores', similarity: 0.7, metadata: { status: 'archived', observation_type: 'decision' } },
        ]),
      }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-6' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  describe('with hydrated spore data', () => {
    beforeAll(() => {
      setupTestDb();
      registerAgent({ id: 'agent-fmt', name: 'test', created_at: NOW });
      insertSpore({ id: 'spore-a', agent_id: 'agent-fmt', observation_type: 'gotcha', content: 'Always validate JWT expiry', created_at: NOW, status: 'active' });
      insertSpore({ id: 'spore-b', agent_id: 'agent-fmt', observation_type: 'decision', content: 'Use session ID as durable key', created_at: NOW, status: 'active' });
      for (let i = 0; i < 6; i++) {
        insertSpore({ id: `spore-lim-${i}`, agent_id: 'agent-fmt', observation_type: 'gotcha', content: `Observation number ${i}`, created_at: NOW, status: 'active' });
      }
    });
    afterAll(() => { teardownTestDb(); });

    it('returns formatted spores when results found', async () => {
      const handler = createPromptContextHandler(makeDeps({
        embeddingManager: mockEmbeddingManager({
          searchVectors: vi.fn().mockReturnValue([
            { id: 'spore-a', namespace: 'spores', similarity: 0.85, metadata: { status: 'active', observation_type: 'gotcha' } },
            { id: 'spore-b', namespace: 'spores', similarity: 0.72, metadata: { status: 'active', observation_type: 'decision' } },
          ]),
        }),
      }));
      const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-7' }));
      const text = (result.body as { text: string }).text;

      expect(text).toContain('Relevant vault observations:');
      expect(text).toContain('(gotcha)');
      expect(text).toContain('(decision)');
      expect(text).toContain('Always validate JWT expiry');
    });

    it('respects max spores limit', async () => {
      const vectorResults = Array.from({ length: 6 }, (_, i) => ({
        id: `spore-lim-${i}`,
        namespace: 'spores',
        similarity: 0.9 - i * 0.05,
        metadata: { status: 'active', observation_type: 'gotcha' },
      }));

      const handler = createPromptContextHandler(makeDeps({
        config: makeConfig({ prompt_max_spores: 2 }),
        embeddingManager: mockEmbeddingManager({ searchVectors: vi.fn().mockReturnValue(vectorResults) }),
      }));
      const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-8' }));
      const text = (result.body as { text: string }).text;

      const lines = text.split('\n').filter((l: string) => l.startsWith('- ('));
      expect(lines).toHaveLength(2);
    });
  });
});
