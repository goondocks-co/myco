import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildInjectedContext, buildPromptContext } from '@myco/context/injector';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';

// Mock tryEmbed to return null immediately — no real embedding provider in tests
vi.mock('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));
import { upsertSession } from '@myco/db/queries/sessions';
import { upsertPlan } from '@myco/db/queries/plans';
import { insertSpore } from '@myco/db/queries/spores';
import { registerAgent } from '@myco/db/queries/agents';
import { MycoConfigSchema } from '@myco/config/schema';

describe('buildInjectedContext', () => {
  const config = MycoConfigSchema.parse({
    version: 3,
  });

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  it('returns empty text when DB has no data', async () => {
    const result = await buildInjectedContext(config, {});
    expect(result.text).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('returns session-based context when sessions exist', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertSession({
      id: 'sess-001',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      title: 'Auth Middleware Refactor',
      summary: 'Refactored the auth middleware to use JWT tokens',
      status: 'completed',
    });

    const result = await buildInjectedContext(config, {});
    expect(result.layers.sessions).toContain('Auth Middleware Refactor');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('includes active plans in context', async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertPlan({
      id: 'plan-auth',
      created_at: now,
      status: 'active',
      title: 'Auth Redesign',
      content: 'Replace JWT with session tokens for better security.',
    });

    const result = await buildInjectedContext(config, {});
    expect(result.layers.plans).toContain('Auth Redesign');
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('includes active spores in context', async () => {
    const now = Math.floor(Date.now() / 1000);
    await registerAgent({
      id: 'agent-1',
      name: 'test-agent',
      created_at: now,
    });
    await insertSpore({
      id: 'spore-001',
      agent_id: 'agent-1',
      observation_type: 'gotcha',
      content: 'Always validate JWT expiry before refreshing tokens',
      created_at: now,
      status: 'active',
    });

    const result = await buildInjectedContext(config, {});
    expect(result.layers.spores).toContain('gotcha');
    expect(result.layers.spores).toContain('Always validate JWT');
  });

  it('excludes superseded spores', async () => {
    const now = Math.floor(Date.now() / 1000);
    await registerAgent({
      id: 'agent-1',
      name: 'test-agent',
      created_at: now,
    });
    await insertSpore({
      id: 'spore-old',
      agent_id: 'agent-1',
      observation_type: 'gotcha',
      content: 'Old stale observation',
      created_at: now,
      status: 'superseded',
    });

    const result = await buildInjectedContext(config, {});
    expect(result.layers.spores).toBe('');
  });

  it('respects total max_tokens budget', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Add many sessions to potentially exceed budget
    for (let i = 0; i < 20; i++) {
      await upsertSession({
        id: `sess-${i.toString().padStart(3, '0')}`,
        agent: 'claude-code',
        started_at: now - i,
        created_at: now - i,
        title: `Session ${i}`,
        summary: 'A'.repeat(500),
      });
    }

    const result = await buildInjectedContext(config, {});
    // Token estimate should be reasonable (within default budget + tolerance)
    expect(result.tokenEstimate).toBeLessThanOrEqual(1250);
  });
});

describe('buildPromptContext', () => {
  const config = MycoConfigSchema.parse({
    version: 3,
  });

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  it('returns empty context for short prompts', async () => {
    const result = await buildPromptContext('hi', config);
    expect(result.text).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('returns empty context when no embedding provider available', async () => {
    // No provider configured in test env — tryEmbed returns null
    const result = await buildPromptContext('How should I handle authentication middleware?', config);
    expect(result.text).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });
});
