import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

/**
 * Helper: build a temp vault dir with a pre-seeded machine_id so
 * `buildCortexInstructionsInput` can derive (project_id, machine_id)
 * deterministically without writing to the real filesystem.
 */
function makeVaultDir(): { vaultDir: string; machineId: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cortex-brief-'));
  const vaultDir = path.join(dir, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const machineId = 'test-machine';
  fs.writeFileSync(path.join(vaultDir, 'machine_id'), machineId, 'utf-8');
  return { vaultDir, machineId, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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

  // Keep presence checks for the survivors of the 2026-04-22 MCP surface cleanup
  // so a future refactor can't silently drop them from the brief.
  it('includes the canonical retrieval tools by name', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    expect(names).toContain('myco_runs');
    expect(names).toContain('myco_plans');
  });

  it('injects canonical retrieval guidance into the brief body', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });
    const body = lines.join('\n');
    expect(body).toContain('`myco_runs`');
  });

  // Anti-drift for the 2026-04-22 retirements — none of these tools must
  // reappear in the Cortex brief. If one does, the MCP surface has drifted.
  it('excludes every retired MCP surface from the brief', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    for (const retired of [
      'myco_team',
      'myco_graph',
      'myco_cortex',
      'myco_skill_candidates',
      'myco_evaluations',
      'myco_write_intents',
      'myco_phase_audit',
      'myco_resume_run',
      'myco_digest_revisions',
    ]) {
      expect(names).not.toContain(retired);
    }
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

    const { vaultDir, cleanup } = makeVaultDir();
    const result = await buildCortexInstructionsInput(config, vaultDir);
    cleanup();

    expect(result.instruction).toContain('## Current digest excerpt');
    expect(result.instruction).toContain('Current digest says the Cortex rollout is in progress');
    expect(result.instruction).toContain('## Recent sessions');
    expect(result.instruction).toContain('Cortex instructions follow-up');
    expect(result.instruction).toContain('## Recent decision spores');
    expect(result.instruction).toContain('static retrieval boilerplate');
    expect(result.instruction).toContain('## Recent plans');
    expect(result.instruction).toContain('not a task list for this session');
    expect(result.instruction).toContain('Finish Cortex instruction refresh');
    expect(result.instruction).toContain('`myco_save_plan`');
    expect(result.instruction).toContain('Pass `source_path` when the plan is also written to disk');
    expect(result.instruction).toContain('do not instruct it to call `myco_skills`');
  });

  it('emits the canopy_map() directive only when a populated map exists for the project', async () => {
    const config = MycoConfigSchema.parse({ version: 3, context: { cortex_enabled: true } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: resolveCanopyProjectId(vaultDir),
      machine_id: machineId,
      content: '## Directory skeleton\n- src/ — application code\n',
      inputs_hash: 'h-test-1',
      token_estimate: 25,
      generated_by_run_id: null,
    });

    const result = await buildCortexInstructionsInput(config, vaultDir);
    cleanup();
    expect(result.instruction).toContain('canopy_map()');
    expect(result.instruction).toContain('default opener');
  });

  it('omits the canopy_map() directive when the project has no map yet', async () => {
    const config = MycoConfigSchema.parse({ version: 3, context: { cortex_enabled: true } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, cleanup } = makeVaultDir();
    // No writeCanopyMap — the map row is missing.
    const result = await buildCortexInstructionsInput(config, vaultDir);
    cleanup();
    expect(result.instruction).not.toContain('canopy_map()');
  });

  it('omits the canopy_map() directive when the stored map is empty', async () => {
    const config = MycoConfigSchema.parse({ version: 3, context: { cortex_enabled: true } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: resolveCanopyProjectId(vaultDir),
      machine_id: machineId,
      content: '',
      inputs_hash: 'h-empty',
      token_estimate: 0,
      generated_by_run_id: null,
    });
    const result = await buildCortexInstructionsInput(config, vaultDir);
    cleanup();
    expect(result.instruction).not.toContain('canopy_map()');
  });

  it('omits the canopy_map() directive when Cortex is disabled, even with a populated map', async () => {
    const config = MycoConfigSchema.parse({ version: 3, context: { cortex_enabled: false } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: resolveCanopyProjectId(vaultDir),
      machine_id: machineId,
      content: '## Map\n',
      inputs_hash: 'h-disabled',
      token_estimate: 10,
      generated_by_run_id: null,
    });
    const result = await buildCortexInstructionsInput(config, vaultDir);
    cleanup();
    expect(result.instruction).not.toContain('canopy_map()');
  });
});
