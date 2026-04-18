import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  buildCortexInstructionsInput,
  buildRetrievalGuidanceLines,
  RETRIEVAL_GUIDANCE,
  resolveCortexCapabilities,
  resolveInstructionDelivery,
} from '@myco/context/cortex-brief.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { buildPlanId } from '@myco/plans/identity.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

const NOW = Math.floor(Date.now() / 1000);

describe('buildRetrievalGuidanceLines', () => {
  it('does not encode myco_skills guidance into Cortex instructions', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });

    expect(lines.join('\n')).toContain('`myco_context`');
    expect(lines.join('\n')).toContain('`myco_search`');
    expect(lines.join('\n')).toContain('`myco_save_plan`');
    expect(lines.join('\n')).not.toContain('`myco_skills`');
  });

  it('filters team and collective guidance by runtime capabilities', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });

    expect(lines.join('\n')).not.toContain('`myco_team`');
    expect(lines.join('\n')).not.toContain('`collective_search`');
  });
});

describe('RETRIEVAL_GUIDANCE', () => {
  it('orders Cortex-enabled tools by priority', () => {
    expect(RETRIEVAL_GUIDANCE.map((entry) => entry.tool).slice(0, 3)).toEqual([
      'myco_context',
      'myco_search',
      'myco_recall',
    ]);
  });

  // Anti-drift for Bundle D (pre-0.21.0 MCP parity).
  // If someone removes one of these tools from TOOL_DEFINITIONS or strips
  // its `cortex` entry, the brief would silently stop advertising the new
  // parity surfaces and agents would lose the session-start guidance.
  it('includes the Bundle D must-ship tools so the Cortex brief advertises them', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    expect(names).toContain('myco_cortex');
    expect(names).toContain('myco_runs');
    // myco_plans has always been in the brief, but Bundle D extended its
    // schema. Keep a presence check so a future refactor can't drop it.
    expect(names).toContain('myco_plans');
  });

  it('injects Bundle D tool guidance into the brief body', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });
    const body = lines.join('\n');
    expect(body).toContain('`myco_cortex`');
    expect(body).toContain('`myco_runs`');
  });

  // Anti-drift for Bundle G (post-0.21 follow-ups). Every new MCP surface
  // must show up in the Cortex brief by name — if a future refactor strips
  // any tool's `cortex` entry, agents would silently lose the session-start
  // guidance that tells them what the tool is for.
  it('includes every Bundle G tool by name', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    expect(names).toContain('myco_evaluations');
    expect(names).toContain('myco_write_intents');
    expect(names).toContain('myco_phase_audit');
    expect(names).toContain('myco_resume_run');
    expect(names).toContain('myco_digest_revisions');
  });

  it('injects Bundle G tool guidance into the brief body', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });
    const body = lines.join('\n');
    expect(body).toContain('`myco_evaluations`');
    expect(body).toContain('`myco_write_intents`');
    expect(body).toContain('`myco_phase_audit`');
    expect(body).toContain('`myco_resume_run`');
    expect(body).toContain('`myco_digest_revisions`');
  });
});

describe('resolveInstructionDelivery', () => {
  const enabledContext = MycoConfigSchema.parse({ version: 3 }).context;
  const disabledContext = MycoConfigSchema.parse({
    version: 3,
    context: { cortex_enabled: false },
  }).context;

  const cases: Array<{
    label: string;
    context: typeof enabledContext;
    symbiont: { supportsSessionStartInjection: boolean } | null;
    expected: ReturnType<typeof resolveInstructionDelivery>;
  }> = [
    {
      label: 'null symbiont → inline with missing-symbiont reason',
      context: enabledContext,
      symbiont: null,
      expected: { inlineInstructions: true, reason: 'missing-symbiont' },
    },
    {
      label: 'cortex disabled → inline regardless of symbiont support',
      context: disabledContext,
      symbiont: { supportsSessionStartInjection: true },
      expected: { inlineInstructions: true, reason: 'session-start-disabled' },
    },
    {
      label: 'symbiont supports injection → NOT inline',
      context: enabledContext,
      symbiont: { supportsSessionStartInjection: true },
      expected: { inlineInstructions: false, reason: 'session-start-supported' },
    },
    {
      label: 'symbiont lacks injection support → inline with no-session-start',
      context: enabledContext,
      symbiont: { supportsSessionStartInjection: false },
      expected: { inlineInstructions: true, reason: 'no-session-start' },
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      expect(resolveInstructionDelivery(testCase.context, testCase.symbiont))
        .toEqual(testCase.expected);
    });
  }
});

describe('resolveCortexCapabilities', () => {
  it('returns collectiveConnected=false and empty capabilities when the team client throws', async () => {
    const config = { team: { enabled: true } } as const;
    const throwingClient = {
      getCollectiveStatus: () => { throw new Error('team sync offline'); },
    };
    const result = await resolveCortexCapabilities(
      config as never,
      () => throwingClient as never,
    );
    expect(result.teamEnabled).toBe(true);
    expect(result.collectiveConnected).toBe(false);
    expect(result.collectiveCapabilities).toEqual([]);
  });
});

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
