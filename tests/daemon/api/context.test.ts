import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema';
import type { MycoConfig } from '@myco/config/schema';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { insertSpore } from '@myco/db/queries/spores';
import { registerAgent } from '@myco/db/queries/agents';
import { upsertSession } from '@myco/db/queries/sessions';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts';
import {
  createSessionContextHandler,
  createPromptContextHandler,
  createResumeContextHandler,
} from '@myco/daemon/api/context';
import type { ContextDeps } from '@myco/daemon/api/context';
import type { RouteRequest } from '@myco/daemon/router';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';
import type { DaemonLogger } from '@myco/daemon/logger';
import { DEFAULT_AGENT_ID } from '@myco/constants';

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

function makeDeps(overrides: Partial<ContextDeps> & { config?: MycoConfig } = {}): ContextDeps {
  const { config, liveConfig, ...rest } = overrides;
  return {
    vaultDir: '/tmp/myco-test-vault',
    embeddingManager: mockEmbeddingManager(),
    logger: mockLogger(),
    liveConfig: liveConfig ?? { current: config ?? MycoConfigSchema.parse({ version: 3 }) },
    ...rest,
  };
}

function makeConfig(overrides: Partial<MycoConfig['context']> = {}): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3,
    context: overrides,
  });
}

const NOW = Math.floor(Date.now() / 1000);

describe('createSessionContextHandler', () => {
  beforeAll(() => {
    setupTestDb();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
  });

  it('returns stored Cortex instructions with branch and session metadata', async () => {
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_context` before major changes.',
      input_hash: 'hash-session',
      generated_at: NOW,
    });
    const handler = createSessionContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'sess-1', branch: 'main' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('cortex');
    expect(body.text).toContain('myco_context');
    expect(body.text).toContain('Branch:: `main`');
    expect(body.text).toContain('Session:: `sess-1`');
  });

  it('returns empty when no stored Cortex instructions exist', async () => {
    const handler = createSessionContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'sess-2' }));
    const body = result.body as { text: string };

    expect(body.text).toBe('');
  });

  it('returns empty when session-start injection is disabled', async () => {
    const handler = createSessionContextHandler(makeDeps({
      config: makeConfig({ operating_brief_enabled: false }),
    }));
    const result = await handler(makeReq({ session_id: 'sess-3', branch: 'feat' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('appends the preferred digest when digest injection is enabled', async () => {
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'myco-agent',
      created_at: NOW,
    });
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_context` before major changes.',
      input_hash: 'hash-session-digest',
      generated_at: NOW,
    });
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 5000,
      content: 'Digest extract for current project work.',
      generated_at: NOW,
    });
    const handler = createSessionContextHandler(makeDeps({
      config: makeConfig({ session_start_digest_enabled: true }),
    }));

    const result = await handler(makeReq({ session_id: 'sess-digest', branch: 'main' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('cortex+digest:5000');
    expect(body.text).toContain('Use `myco_context` before major changes.');
    expect(body.text).toContain('## Preferred Digest (Tier 5000)');
    expect(body.text).toContain('Digest extract for current project work.');
  });
});

describe('createResumeContextHandler', () => {
  beforeAll(() => {
    setupTestDb();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
  });

  it('returns empty when no parent session exists', async () => {
    const handler = createResumeContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'resume-1', parent_session_id: 'missing-parent' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns a compact recap from the parent session', async () => {
    upsertSession({
      id: 'parent-1',
      agent: 'opencode',
      started_at: NOW,
      created_at: NOW,
      branch: 'feat/opencode',
      title: 'Opencode capture follow-up',
      summary: 'Added richer tool metadata and improved idle-time assistant summaries.',
    });

    const handler = createResumeContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'resume-2', parent_session_id: 'parent-1' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('resume');
    expect(body.text).toContain('Resuming work from: Opencode capture follow-up');
    expect(body.text).toContain('Added richer tool metadata');
    expect(body.text).toContain('Branch:: `feat/opencode`');
    expect(body.text).toContain('Previous Session:: `parent-1`');
    expect(body.text).toContain('Session:: `resume-2`');
  });
});

describe('createPromptContextHandler', () => {
  beforeAll(() => {
    setupTestDb();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
  });

  it('returns empty text when prompt_search is disabled', async () => {
    const handler = createPromptContextHandler(makeDeps({ config: makeConfig({ prompt_search: false }) }));
    const result = await handler(makeReq({ prompt: 'How should I handle auth?', session_id: 's-1' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty text for short prompts', async () => {
    const handler = createPromptContextHandler(makeDeps());
    const result = await handler(makeReq({ prompt: 'hi', session_id: 's-2' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty text when embedding provider is unavailable', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({ embedQuery: vi.fn().mockResolvedValue(null) }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-3' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty text when no search results exist', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({ searchVectors: vi.fn().mockReturnValue([]) }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-4' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty text when max_spores is 0', async () => {
    const handler = createPromptContextHandler(makeDeps({ config: makeConfig({ prompt_max_spores: 0 }) }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-5' }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty text when all spores are excluded by status', async () => {
    const handler = createPromptContextHandler(makeDeps({
      embeddingManager: mockEmbeddingManager({
        searchVectors: vi.fn().mockReturnValue([
          { id: 'spore-1', namespace: 'spores', similarity: 0.8, metadata: { status: 'superseded', observation_type: 'gotcha' } },
          { id: 'spore-2', namespace: 'spores', similarity: 0.7, metadata: { status: 'archived', observation_type: 'decision' } },
        ]),
      }),
    }));
    const result = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-6' }));
    const text = (result.body as { text: string }).text;

    expect(text).toBe('');
  });

  describe('with hydrated spore data', () => {
    beforeEach(() => {
      cleanTestDb();
      registerAgent({ id: 'agent-fmt', name: 'test', created_at: NOW });
      insertSpore({ id: 'spore-a', agent_id: 'agent-fmt', observation_type: 'gotcha', content: 'Always validate JWT expiry', created_at: NOW, status: 'active' });
      insertSpore({ id: 'spore-b', agent_id: 'agent-fmt', observation_type: 'decision', content: 'Use session ID as durable key', created_at: NOW, status: 'active' });
      for (let i = 0; i < 6; i++) {
        insertSpore({ id: `spore-lim-${i}`, agent_id: 'agent-fmt', observation_type: 'gotcha', content: `Observation number ${i}`, created_at: NOW, status: 'active' });
      }
    });

    it('returns formatted spores when results are found', async () => {
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

      const lines = text.split('\n').filter((line: string) => line.startsWith('- ('));
      expect(lines).toHaveLength(2);
    });
  });
});
