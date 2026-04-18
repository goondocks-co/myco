import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { buildCortexInstructionsInput } from '@myco/cortex/instructions-input.js';
import { buildPlanId } from '@myco/plans/identity.js';

const NOW = Math.floor(Date.now() / 1000);

describe('buildCortexInstructionsInput', () => {
  beforeAll(() => {
    setupTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
  });

  it('includes digest, recent sessions, recent spores, and active plans', async () => {
    const config = MycoConfigSchema.parse({ version: 3 });

    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'default-agent',
      created_at: NOW,
    });

    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: config.context.digest_tier,
      content: 'Current digest says the Cortex rollout is in progress and focused on session-start guidance.',
      generated_at: NOW,
    });

    upsertSession({
      id: 'sess-cortex-1',
      agent: 'codex',
      started_at: NOW,
      created_at: NOW,
      branch: 'feature/cortex',
      title: 'Cortex instructions follow-up',
      summary: 'Tightened the session-start instructions and moved digest retrieval into Cortex.',
      status: 'completed',
    });

    registerAgent({
      id: 'agent-cortex',
      name: 'myco-agent',
      created_at: NOW,
    });

    insertSpore({
      id: 'spore-cortex-1',
      agent_id: 'agent-cortex',
      observation_type: 'decision',
      content: 'Cortex instructions should mention current vault activity instead of static retrieval boilerplate.',
      created_at: NOW,
      status: 'active',
      session_id: 'sess-cortex-1',
    });

    upsertPlan({
      id: buildPlanId('session:sess-cortex-1:key:primary'),
      logical_key: 'session:sess-cortex-1:key:primary',
      created_at: NOW,
      status: 'active',
      title: 'Finish Cortex instruction refresh',
      content: 'Teach more tools, include recent vault pulse, and stop routing skills through MCP.',
      session_id: 'sess-cortex-1',
    });

    const result = await buildCortexInstructionsInput(config);

    expect(result.instruction).toContain('## Current digest excerpt');
    expect(result.instruction).toContain('Current digest says the Cortex rollout is in progress');
    expect(result.instruction).toContain('## Recent sessions');
    expect(result.instruction).toContain('Cortex instructions follow-up');
    expect(result.instruction).toContain('## Recent spores');
    expect(result.instruction).toContain('static retrieval boilerplate');
    expect(result.instruction).toContain('## Active plans');
    expect(result.instruction).toContain('Finish Cortex instruction refresh');
    expect(result.instruction).toContain('`myco_save_plan`');
    expect(result.instruction).toContain('Pass `source_path` when the plan is also written to disk');
    expect(result.instruction).toContain('do not instruct it to call `myco_skills`');
  });
});
