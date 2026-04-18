import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { buildInjectedContext } from '@myco/context/injector';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions';
import { insertSpore } from '@myco/db/queries/spores';
import { registerAgent } from '@myco/db/queries/agents';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts';
import { MycoConfigSchema } from '@myco/config/schema';
import { upsertCortexInstructions } from '@myco/db/queries/cortex-instructions';
import { DEFAULT_AGENT_ID } from '@myco/constants';

vi.mock('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));

describe('buildInjectedContext', () => {
  const config = MycoConfigSchema.parse({
    version: 3,
  });

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns empty context when no stored Cortex instructions exist', async () => {
    const result = await buildInjectedContext(config, {});

    expect(result.text).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('reads the stored Cortex instructions in degraded mode', async () => {
    const now = Math.floor(Date.now() / 1000);
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_context` before major changes.',
      input_hash: 'hash-1',
      generated_at: now,
    });
    upsertSession({
      id: 'sess-001',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
      title: 'Auth Middleware Refactor',
      summary: 'Refactored the auth middleware to use JWT tokens',
      status: 'completed',
    });
    registerAgent({
      id: 'agent-1',
      name: 'test-agent',
      created_at: now,
    });
    insertSpore({
      id: 'spore-001',
      agent_id: 'agent-1',
      observation_type: 'gotcha',
      content: 'Always validate JWT expiry before refreshing tokens',
      created_at: now,
      status: 'active',
    });

    const result = await buildInjectedContext(config, {});

    expect(result.text).toContain('Use `myco_context` before major changes.');
    expect(result.text).not.toContain('Auth Middleware Refactor');
    expect(result.text).not.toContain('Always validate JWT expiry');
  });

  it('returns empty when session-start instructions are disabled', async () => {
    const disabledConfig = MycoConfigSchema.parse({
      version: 3,
      context: {
        cortex_enabled: false,
      },
    });
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_context` before major changes.',
      input_hash: 'hash-disabled',
      generated_at: Math.floor(Date.now() / 1000),
    });

    const result = await buildInjectedContext(disabledConfig, {});
    expect(result.text).toBe('');
  });

  it('appends the preferred digest when session-start digest injection is enabled', async () => {
    const now = Math.floor(Date.now() / 1000);
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'myco-agent',
      created_at: now,
    });
    upsertCortexInstructions({
      agent_id: DEFAULT_AGENT_ID,
      content: 'Use `myco_context` before major changes.',
      input_hash: 'hash-digest',
      generated_at: now,
    });
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: 5000,
      content: 'Digest extract for active project work.',
      generated_at: now,
    });
    const digestConfig = MycoConfigSchema.parse({
      version: 3,
      context: {
        session_start_digest_enabled: true,
      },
    });

    const result = await buildInjectedContext(digestConfig, {});

    expect(result.text).toContain('Use `myco_context` before major changes.');
    expect(result.text).toContain('## Preferred Digest (Tier 5000)');
    expect(result.text).toContain('Digest extract for active project work.');
  });
});

