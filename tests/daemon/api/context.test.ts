import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
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
  createSubagentContextHandler,
} from '@myco/daemon/api/context';
import type { ContextDeps } from '@myco/daemon/api/context';
import type { RouteRequest } from '@myco/daemon/router';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager';
import type { DaemonLogger } from '@myco/daemon/logger';
import { DEFAULT_AGENT_ID } from '@myco/constants';
import { listActivities } from '@myco/db/queries/activities';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
function makeReq(body: unknown): RouteRequest {
  return { params: {}, query: {}, body, pathname: '/context', requestContext: TEST_REQUEST_CONTEXT };
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

interface LegacyContextOverride {
  cortex_enabled?: boolean;
  session_start_digest_enabled?: boolean;
  digest_tier?: number;
  prompt_search?: boolean;
  prompt_max_spores?: number;
}

/**
 * Tests still author overrides in the pre-v8 vocabulary (cortex_enabled,
 * prompt_search, etc.) for readability. Map them to the new shape on the
 * way into MycoConfigSchema.parse so each test stays focused on its
 * behavior, not the schema migration.
 */
function makeConfig(overrides: LegacyContextOverride = {}): MycoConfig {
  const cortex: Record<string, Record<string, unknown>> = {};
  if ('cortex_enabled' in overrides) {
    cortex.instructions = { inject_on_session_start: overrides.cortex_enabled };
  }
  if ('session_start_digest_enabled' in overrides || 'digest_tier' in overrides) {
    cortex.digest = {};
    if ('digest_tier' in overrides) cortex.digest.tier = overrides.digest_tier;
    if ('session_start_digest_enabled' in overrides) {
      cortex.digest.inject_on_session_start = overrides.session_start_digest_enabled;
    }
  }
  if ('prompt_search' in overrides || 'prompt_max_spores' in overrides) {
    cortex.spores = {};
    if ('prompt_search' in overrides) cortex.spores.inject_on_prompt_submit = overrides.prompt_search;
    if ('prompt_max_spores' in overrides) cortex.spores.max_per_prompt = overrides.prompt_max_spores;
  }
  return MycoConfigSchema.parse({
    version: 3,
    cortex,
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
      content: 'Use `myco_cortex` before major changes.',
      input_hash: 'hash-session',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    const handler = createSessionContextHandler(makeDeps());
    const result = await handler(makeReq({ session_id: 'sess-1', branch: 'main' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('cortex');
    expect(body.text).toContain('myco_cortex');
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
      config: makeConfig({ cortex_enabled: false }),
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
      content: 'Use `myco_cortex` before major changes.',
      input_hash: 'hash-session-digest',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 5000,
      content: 'Digest extract for current project work.',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    const handler = createSessionContextHandler(makeDeps({
      config: makeConfig({ session_start_digest_enabled: true }),
    }));

    const result = await handler(makeReq({ session_id: 'sess-digest', branch: 'main' }));
    const body = result.body as { text: string; source: string };

    expect(body.source).toBe('cortex+digest:5000');
    expect(body.text).toContain('Use `myco_cortex` before major changes.');
    expect(body.text).toContain('## Preferred Digest (Tier 5000)');
    expect(body.text).toContain('Digest extract for current project work.');
  });

  it('returns empty text on the second call when a prompt_batches row pins dedup', async () => {
    // First call: no batch yet → injection record gate falls through and
    // returns the text. Second call after a batch is opened → dedup gate
    // fires (UNIQUE on content_hash) and returns empty.
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Cortex preamble.',
      input_hash: 'hash-dedup',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    const { insertBatch } = await import('@myco/db/queries/batches');
    upsertSession({
      id: 'sess-dedup',
      agent: 'antigravity',
      started_at: NOW,
      created_at: NOW,
    });
    const handler = createSessionContextHandler(makeDeps());

    insertBatch({
      session_id: 'sess-dedup',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'hello',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });

    const first = await handler(makeReq({ session_id: 'sess-dedup' }));
    expect((first.body as { text: string }).text).toContain('Cortex preamble');

    const second = await handler(makeReq({ session_id: 'sess-dedup' }));
    expect((second.body as { text: string }).text).toBe('');
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

describe('createSubagentContextHandler', () => {
  beforeAll(() => {
    setupTestDb();
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
  });

  it('returns managed Cortex instructions and records a subagent injection activity for supported symbionts', async () => {
    const { insertBatch, getBatchById } = await import('@myco/db/queries/batches');
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_cortex` before major changes.\n\nPrefer Canopy before raw search.',
      input_hash: 'hash-subagent',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
      source_run_id: 'run-subagent-cortex',
    });
    upsertSession({
      id: 'sess-subagent',
      agent: 'codex',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    const batch = insertBatch({
      session_id: 'sess-subagent',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'spawn a reviewer',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });

    const handler = createSubagentContextHandler(makeDeps());
    const result = await handler(makeReq({
      session_id: 'sess-subagent',
      agent: 'codex',
      agent_id: 'agent-123',
      agent_type: 'reviewer',
    }));
    const body = result.body as { text: string; source: string; sourceRunId: string | null; generatedAt: number | null };

    expect(body.source).toBe('cortex-subagent');
    expect(body.sourceRunId).toBe('run-subagent-cortex');
    expect(body.generatedAt).toBe(NOW);
    expect(body.text).toContain('You are a delegated subagent working inside a Myco-connected project.');
    expect(body.text).toContain('Use `myco_cortex` before major changes.');
    expect(body.text).toContain('Prefer Canopy before raw search.');

    const activities = listActivities({ session_id: 'sess-subagent', scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0]!.tool_name).toBe('myco:inject_subagent');
    expect(activities[0]!.content_hash).toBe('myco:inject:subagent:sess-subagent:agent-123');
    expect(JSON.parse(activities[0]!.tool_input!)).toMatchObject({
      source: 'subagent-start',
      agent: 'codex',
      agent_id: 'agent-123',
      agent_type: 'reviewer',
    });
    expect(activities[0]!.tool_output_summary).toContain('Use `myco_cortex` before major changes.');
    expect(getBatchById(batch.id, ALL_PROJECTS_SCOPE)!.activity_count).toBe(1);
  });

  it('suppresses duplicate subagent injection for the same child agent id', async () => {
    const { insertBatch } = await import('@myco/db/queries/batches');
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Cortex subagent dedup content.',
      input_hash: 'hash-subagent-dedup',
      generated_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    upsertSession({
      id: 'sess-subagent-dedup',
      agent: 'claude-code',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    insertBatch({
      session_id: 'sess-subagent-dedup',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'spawn a reviewer',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });

    const handler = createSubagentContextHandler(makeDeps());
    const payload = {
      session_id: 'sess-subagent-dedup',
      agent: 'claude-code',
      agent_id: 'agent-dup',
      agent_type: 'reviewer',
    };

    const first = await handler(makeReq(payload));
    expect((first.body as { text: string }).text).toContain('Cortex subagent dedup content');

    const second = await handler(makeReq(payload));
    expect((second.body as { text: string }).text).toBe('');
    expect(listActivities({ session_id: 'sess-subagent-dedup', scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('returns empty when no managed Cortex instructions are stored', async () => {
    const handler = createSubagentContextHandler(makeDeps());
    const result = await handler(makeReq({
      session_id: 'sess-subagent-empty',
      agent: 'codex',
      agent_id: 'agent-1',
      agent_type: 'reviewer',
    }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty for symbionts that do not declare subagent-start injection', async () => {
    const handler = createSubagentContextHandler(makeDeps());
    const result = await handler(makeReq({
      session_id: 'sess-unsupported',
      agent: 'cursor',
      agent_id: 'agent-1',
      agent_type: 'reviewer',
    }));

    expect((result.body as { text: string }).text).toBe('');
  });

  it('returns empty when subagent context injection is disabled in config', async () => {
    const handler = createSubagentContextHandler(makeDeps({
      config: MycoConfigSchema.parse({
        version: 3,
        cortex: {
          instructions: { inject_on_subagent_start: false },
        },
      }),
    }));
    const result = await handler(makeReq({
      session_id: 'sess-disabled',
      agent: 'codex',
      agent_id: 'agent-1',
      agent_type: 'reviewer',
    }));

    expect((result.body as { text: string }).text).toBe('');
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

  // --- Plan-intent nudge (Phase 4) ---

  it('appends the plan-intent nudge when intent is present and the toggle is on', async () => {
    const handler = createPromptContextHandler(makeDeps());
    const result = await handler(makeReq({ prompt: 'please plan the migration', session_id: 'sess-nudge-1' }));
    expect((result.body as { text: string }).text).toContain('Myco is where plans live');
  });

  it('does NOT inject the nudge when the prompt has no planning intent', async () => {
    const handler = createPromptContextHandler(makeDeps());
    const result = await handler(makeReq({ prompt: 'fix the bug in foo.ts', session_id: 'sess-nudge-2' }));
    expect((result.body as { text: string }).text).not.toContain('Myco is where plans live');
  });

  it('injects the nudge even when spore injection is disabled', async () => {
    const handler = createPromptContextHandler(makeDeps({ config: makeConfig({ prompt_search: false }) }));
    const result = await handler(makeReq({ prompt: 'write a spec for X', session_id: 'sess-nudge-3' }));
    expect((result.body as { text: string }).text).toContain('Myco is where plans live');
  });

  it('injects the nudge at most once per session', async () => {
    const { insertBatch } = await import('@myco/db/queries/batches');
    upsertSession({ id: 'sess-nudge-4', agent: 'claude-code', started_at: NOW, created_at: NOW });
    insertBatch({
      session_id: 'sess-nudge-4',
      kind: 'initial',
      prompt_number: 1,
      user_prompt: 'plan',
      started_at: NOW,
      created_at: NOW,
      project_id: TEST_REQUEST_CONTEXT.projectId,
    });
    const handler = createPromptContextHandler(makeDeps());
    const first = await handler(makeReq({ prompt: 'please plan the migration', session_id: 'sess-nudge-4' }));
    const second = await handler(makeReq({ prompt: 'let us plan it again now', session_id: 'sess-nudge-4' }));
    expect((first.body as { text: string }).text).toContain('Myco is where plans live');
    expect((second.body as { text: string }).text).not.toContain('Myco is where plans live');
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
    // A realistic over-fetched candidate pool: low-relevance background spores
    // that let the hubness-aware selector estimate the query's distance
    // distribution. Without them, a tiny 1-2 element mock pool has no spread and
    // the Mutual Proximity gate cannot certify any candidate as relevant.
    const backgroundPool = () =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `spore-lim-${i}`,
        namespace: 'spores',
        similarity: 0.4,
        metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.55, neighbor_std: 0.1 },
      }));

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
            { id: 'spore-a', namespace: 'spores', similarity: 0.88, metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.6, neighbor_std: 0.1 } },
            { id: 'spore-b', namespace: 'spores', similarity: 0.86, metadata: { status: 'active', observation_type: 'decision', neighbor_mean: 0.6, neighbor_std: 0.1 } },
            ...backgroundPool(),
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

    it('dedups identical prompts within a session — second call returns empty when a batch is open', async () => {
      const { insertBatch } = await import('@myco/db/queries/batches');
      upsertSession({
        id: 's-spore-dedup',
        agent: 'antigravity',
        started_at: NOW,
        created_at: NOW,
      });
      insertBatch({
        session_id: 's-spore-dedup',
        kind: 'initial',
        prompt_number: 1,
        user_prompt: 'auth question',
        started_at: NOW,
        created_at: NOW,
        project_id: TEST_REQUEST_CONTEXT.projectId,
      });

      const handler = createPromptContextHandler(makeDeps({
        embeddingManager: mockEmbeddingManager({
          searchVectors: vi.fn().mockReturnValue([
            { id: 'spore-a', namespace: 'spores', similarity: 0.88, metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.6, neighbor_std: 0.1 } },
            ...backgroundPool(),
          ]),
        }),
      }));
      const first = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-spore-dedup' }));
      expect((first.body as { text: string }).text).toContain('Always validate JWT expiry');

      const second = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-spore-dedup' }));
      expect((second.body as { text: string }).text).toBe('');
    });

    it('different prompts inject different spores; an already-injected spore is not repeated (session dedup)', async () => {
      const { insertBatch } = await import('@myco/db/queries/batches');
      upsertSession({
        id: 's-spore-distinct',
        agent: 'antigravity',
        started_at: NOW,
        created_at: NOW,
      });
      insertBatch({
        session_id: 's-spore-distinct',
        kind: 'initial',
        prompt_number: 1,
        user_prompt: 'p1',
        started_at: NOW,
        created_at: NOW,
        project_id: TEST_REQUEST_CONTEXT.projectId,
      });

      // First prompt surfaces spore-a; second prompt surfaces both, but spore-a
      // was already injected so only the fresh spore-b should come through.
      const handler = createPromptContextHandler(makeDeps({
        embeddingManager: mockEmbeddingManager({
          searchVectors: vi.fn()
            .mockReturnValueOnce([
              { id: 'spore-a', namespace: 'spores', similarity: 0.88, metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.6, neighbor_std: 0.1 } },
              ...backgroundPool(),
            ])
            .mockReturnValueOnce([
              { id: 'spore-b', namespace: 'spores', similarity: 0.88, metadata: { status: 'active', observation_type: 'decision', neighbor_mean: 0.6, neighbor_std: 0.1 } },
              { id: 'spore-a', namespace: 'spores', similarity: 0.86, metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.6, neighbor_std: 0.1 } },
              ...backgroundPool(),
            ]),
        }),
      }));
      const first = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-spore-distinct' }));
      const second = await handler(makeReq({ prompt: 'Different prompt about caching strategies', session_id: 's-spore-distinct' }));
      const secondText = (second.body as { text: string }).text;
      expect((first.body as { text: string }).text).toContain('Always validate JWT expiry');
      expect(secondText).toContain('Use session ID as durable key'); // fresh spore-b injected
      expect(secondText).not.toContain('Always validate JWT expiry'); // spore-a deduped
    });

    it('session dedup returns empty when the only relevant spore was already injected', async () => {
      const { insertBatch } = await import('@myco/db/queries/batches');
      upsertSession({ id: 's-spore-only', agent: 'antigravity', started_at: NOW, created_at: NOW });
      insertBatch({
        session_id: 's-spore-only',
        kind: 'initial',
        prompt_number: 1,
        user_prompt: 'p1',
        started_at: NOW,
        created_at: NOW,
        project_id: TEST_REQUEST_CONTEXT.projectId,
      });

      const handler = createPromptContextHandler(makeDeps({
        embeddingManager: mockEmbeddingManager({
          searchVectors: vi.fn().mockReturnValue([
            { id: 'spore-a', namespace: 'spores', similarity: 0.88, metadata: { status: 'active', observation_type: 'gotcha', neighbor_mean: 0.6, neighbor_std: 0.1 } },
            ...backgroundPool(),
          ]),
        }),
      }));
      const first = await handler(makeReq({ prompt: 'How should I handle authentication?', session_id: 's-spore-only' }));
      const second = await handler(makeReq({ prompt: 'A completely different caching question', session_id: 's-spore-only' }));
      expect((first.body as { text: string }).text).toContain('Always validate JWT expiry');
      expect((second.body as { text: string }).text).toBe('');
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
