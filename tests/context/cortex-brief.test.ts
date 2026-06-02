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
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { assertGroveProjectId, createProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';

/**
 * Helper: build a temp vault dir with a pre-seeded machine_id so
 * `buildCortexInstructionsInput` can derive (project_id, machine_id)
 * deterministically without writing to the real filesystem.
 */
function makeVaultDir(): { vaultDir: string; machineId: string; projectId: GroveProjectId; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cortex-brief-'));
  const vaultDir = path.join(dir, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const machineId = 'test-machine';
  fs.writeFileSync(path.join(vaultDir, 'machine_id'), machineId, 'utf-8');
  const manifest = ensureProjectManifest(vaultDir, { projectName: 'cortex-brief-test' });
  const projectId = assertGroveProjectId(manifest.project.id);
  return { vaultDir, machineId, projectId, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function requestContext(vaultDir: string, projectId: string) {
  return resolveLegacyRequestContext(vaultDir, {
    projectRoot: path.dirname(vaultDir),
    projectId,
    groveId: 'grove-test',
    machineId: 'test-machine',
    source: 'explicit',
    // Explicit project/grove pivot = caller-asserted tenancy; the scope seam
    // binds a Grove-bound context to its project scope only when caller-asserted.
    tenancySource: 'caller',
  });
}

const NOW = Math.floor(Date.now() / 1000);

describe('buildRetrievalGuidanceLines', () => {
  it('does not encode myco_skills guidance into Cortex instructions', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });

    expect(lines.join('\n')).toContain('`myco_cortex`');
    expect(lines.join('\n')).toContain('`myco_search`');
    expect(lines.join('\n')).toContain('`myco_plans`');
    expect(lines.join('\n')).not.toContain('`myco_skills`');
  });

  it('teaches cross-session plan pickup by id in the myco_plans guidance', () => {
    const text = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    }).join('\n');
    expect(text).toContain('op: "get"');
    expect(text).toContain('earlier session');
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
      'myco_cortex',
      'myco_search',
      'myco_sessions',
    ]);
  });

  // Keep presence checks for the survivors of the 2026-04-22 MCP surface cleanup
  // so a future refactor can't silently drop them from the brief.
  it('includes the canonical retrieval tools by name', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    expect(names).toContain('myco_agent');
    expect(names).toContain('myco_plans');
  });

  it('injects canonical retrieval guidance into the brief body', () => {
    const lines = buildRetrievalGuidanceLines({
      teamEnabled: false,
      collectiveConnected: false,
      collectiveCapabilities: [],
    });
    const body = lines.join('\n');
    expect(body).toContain('`myco_agent`');
  });

  // Anti-drift for the 2026-04-22 retirements — none of these tools must
  // reappear in the Cortex brief. If one does, the MCP surface has drifted.
  it('excludes every retired MCP surface from the brief', () => {
    const names = RETRIEVAL_GUIDANCE.map((entry) => entry.tool);
    for (const retired of [
      'myco_team',
      'myco_graph',
      'myco_recall',
      'myco_remember',
      'myco_save_plan',
      'myco_context',
      'myco_runs',
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
  const enabledCortex = MycoConfigSchema.parse({ version: 3 }).cortex;
  const disabledCortex = MycoConfigSchema.parse({
    version: 3,
    cortex: { instructions: { inject_on_session_start: false } },
  }).cortex;

  const cases: Array<{
    label: string;
    cortex: typeof enabledCortex;
    symbiont: { supportsSessionStartInjection: boolean } | null;
    expected: ReturnType<typeof resolveInstructionDelivery>;
  }> = [
    {
      label: 'null symbiont → inline with missing-symbiont reason',
      cortex: enabledCortex,
      symbiont: null,
      expected: { inlineInstructions: true, reason: 'missing-symbiont' },
    },
    {
      label: 'cortex disabled → inline regardless of symbiont support',
      cortex: disabledCortex,
      symbiont: { supportsSessionStartInjection: true },
      expected: { inlineInstructions: true, reason: 'session-start-disabled' },
    },
    {
      label: 'symbiont supports injection → NOT inline',
      cortex: enabledCortex,
      symbiont: { supportsSessionStartInjection: true },
      expected: { inlineInstructions: false, reason: 'session-start-supported' },
    },
    {
      label: 'symbiont lacks injection support → inline with no-session-start',
      cortex: enabledCortex,
      symbiont: { supportsSessionStartInjection: false },
      expected: { inlineInstructions: true, reason: 'no-session-start' },
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      expect(resolveInstructionDelivery(testCase.cortex, testCase.symbiont))
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
    const { vaultDir, projectId, cleanup } = makeVaultDir();

    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'default-agent',
      created_at: NOW,
    });

    upsertDigestExtract({
      project_id: projectId,
      agent_id: DEFAULT_AGENT_ID,
      tier: config.cortex.digest.tier,
      content: 'Current digest says the Cortex rollout is in progress and focused on session-start guidance.',
      generated_at: NOW,
    });

    upsertSession({
      id: 'sess-cortex-1',
      project_id: projectId,
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
      project_id: projectId,
      agent_id: 'agent-cortex',
      observation_type: 'decision',
      content: 'Cortex instructions should mention current vault activity instead of static retrieval boilerplate.',
      created_at: NOW,
      status: 'active',
      session_id: 'sess-cortex-1',
    });
    insertSpore({
      id: 'spore-cortex-retired-tool',
      project_id: projectId,
      agent_id: 'agent-cortex',
      observation_type: 'decision',
      content: 'A prior note mentioned myco_recall, but generated instructions should not repeat obsolete tool names.',
      created_at: NOW + 1,
      status: 'active',
      session_id: 'sess-cortex-1',
    });

    upsertPlan({
      id: buildPlanId('session:sess-cortex-1:key:primary'),
      project_id: projectId,
      logical_key: 'session:sess-cortex-1:key:primary',
      created_at: NOW,
      status: 'active',
      title: 'Finish Cortex instruction refresh',
      content: 'Teach more tools, include recent vault pulse, and stop routing skills through MCP.',
      session_id: 'sess-cortex-1',
    });

    const result = await buildCortexInstructionsInput(
      config,
      vaultDir,
      undefined,
      requestContext(vaultDir, projectId),
    );
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
    expect(result.instruction).toContain('`myco_plans`');
    expect(result.instruction).toContain('op: "save"');
    expect(result.instruction).toContain('use the `myco` skill as the fuller workflow reference');
    expect(result.instruction).toContain('compact always-on version of that workflow');
    expect(result.instruction).toContain('before creating a new plan or spec');
    expect(result.instruction).toContain('explicit, optional high-fidelity memory pull');
    expect(result.instruction).toContain('myco_cortex({"op":"digest","tier":5000})');
    expect(result.instruction).toContain('tier 10000 only when the agent has enough context budget');
    expect(result.instruction).toContain('not to pull the digest for narrow edits');
    expect(result.instruction).not.toContain('before implementation');
    expect(result.instruction).toContain('Do not instruct it to call `myco_skills`');
    expect(result.instruction).toContain('Do not mention retired tool names');
    expect(result.instruction).toContain('when composing a child-agent, subagent, teammate, worker session, or other spawned process prompt');
    expect(result.instruction).toContain('Myco has not already injected subagent-start Cortex context');
    expect(result.instruction).toContain('myco_cortex({"op":"instructions"})');
    expect(result.instruction).toContain('include the returned instructions verbatim');
    expect(result.instruction).toContain('myco tool call myco_cortex --json --input \'{"op":"instructions"}\'');
    expect(result.instruction).toContain('Do not assume the returned instructions have any particular heading or section name');
    expect(result.instruction).toContain('Do not introduce additional tool calls inside recent-workstream prose');
    expect(result.instruction).toContain('never invent extra `myco_cortex` ops from recent context');
    expect(result.instruction).toContain('[retired Myco tool]');
    expect(result.instruction).not.toContain('myco_recall');
  });

  it('uses request-context project scope for recent vault context', async () => {
    const config = MycoConfigSchema.parse({ version: 3 });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });
    const projectAId = assertGroveProjectId(createProjectId());
    const projectBId = assertGroveProjectId(createProjectId());

    upsertDigestExtract({
      project_id: projectAId,
      agent_id: DEFAULT_AGENT_ID,
      tier: config.cortex.digest.tier,
      content: 'Project A digest only.',
      generated_at: NOW,
    });
    upsertDigestExtract({
      project_id: projectBId,
      agent_id: DEFAULT_AGENT_ID,
      tier: config.cortex.digest.tier,
      content: 'Project B digest must stay hidden.',
      generated_at: NOW,
    });
    upsertSession({
      id: 'sess-cortex-project-a',
      project_id: projectAId,
      agent: 'codex',
      started_at: NOW,
      created_at: NOW,
      title: 'Project A session',
      summary: 'Project A session summary.',
      status: 'completed',
    });
    upsertSession({
      id: 'sess-cortex-project-b',
      project_id: projectBId,
      agent: 'codex',
      started_at: NOW,
      created_at: NOW,
      title: 'Project B session',
      summary: 'Project B session summary.',
      status: 'completed',
    });
    insertSpore({
      id: 'spore-cortex-project-a',
      project_id: projectAId,
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'Project A decision.',
      created_at: NOW,
      status: 'active',
      session_id: 'sess-cortex-project-a',
    });
    insertSpore({
      id: 'spore-cortex-project-b',
      project_id: projectBId,
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'Project B decision must stay hidden.',
      created_at: NOW,
      status: 'active',
      session_id: 'sess-cortex-project-b',
    });
    upsertPlan({
      id: 'plan-cortex-project-a',
      project_id: projectAId,
      logical_key: 'project-a-plan',
      created_at: NOW,
      status: 'active',
      title: 'Project A plan',
      content: 'Project A plan body.',
    });
    upsertPlan({
      id: 'plan-cortex-project-b',
      project_id: projectBId,
      logical_key: 'project-b-plan',
      created_at: NOW,
      status: 'active',
      title: 'Project B plan',
      content: 'Project B plan body must stay hidden.',
    });

    const { vaultDir, cleanup } = makeVaultDir();
    const result = await buildCortexInstructionsInput(config, vaultDir, undefined, requestContext(vaultDir, projectAId));
    cleanup();

    expect(result.instruction).toContain('Project A digest only');
    expect(result.instruction).toContain('Project A session');
    expect(result.instruction).toContain('Project A decision');
    expect(result.instruction).toContain('Project A plan');
    expect(result.instruction).not.toContain('Project B');
  });

  it('emits the myco_cortex canopy_map directive only when a populated map exists for the project', async () => {
    const config = MycoConfigSchema.parse({ version: 3, cortex: { instructions: { inject_on_session_start: true } } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, projectId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: projectId,
      machine_id: machineId,
      content: '## Directory skeleton\n- src/ — application code\n',
      inputs_hash: 'h-test-1',
      token_estimate: 25,
      generated_by_run_id: null,
    });

    const result = await buildCortexInstructionsInput(
      config,
      vaultDir,
      undefined,
      requestContext(vaultDir, projectId),
    );
    cleanup();
    expect(result.instruction).toContain('myco_cortex');
    expect(result.instruction).toContain('myco_cortex({"op":"canopy_map"})');
    expect(result.instruction).toContain('"op":"canopy_map"');
    expect(result.instruction).toContain('default first move');
    expect(result.instruction).toContain('`op:"digest"` belongs with planning-context guidance for large work');
    expect(result.instruction).not.toContain('`op:"digest"` overlaps with canopy_map');
    // The canopy_map directive paragraph no longer pairs the MCP form with the
    // CLI fallback — the dual-form phrasing produced "do the same thing twice"
    // sentences in generated instructions and led agents to skip the tool. The
    // CLI launcher is still mentioned elsewhere in the brief (as a portable
    // tool-surface fallback), but not as a second canopy_map invocation form.
    expect(result.instruction).not.toContain('myco tool call myco_cortex --json --input \'{"op":"canopy_map"}\'');
  });

  it('omits the myco_cortex canopy_map directive when the project has no map yet', async () => {
    const config = MycoConfigSchema.parse({ version: 3, cortex: { instructions: { inject_on_session_start: true } } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, projectId, cleanup } = makeVaultDir();
    // No writeCanopyMap — the map row is missing.
    const result = await buildCortexInstructionsInput(
      config,
      vaultDir,
      undefined,
      requestContext(vaultDir, projectId),
    );
    cleanup();
    expect(result.instruction).not.toContain('"op":"canopy_map"');
  });

  it('omits the myco_cortex canopy_map directive when the stored map is empty', async () => {
    const config = MycoConfigSchema.parse({ version: 3, cortex: { instructions: { inject_on_session_start: true } } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, projectId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: projectId,
      machine_id: machineId,
      content: '',
      inputs_hash: 'h-empty',
      token_estimate: 0,
      generated_by_run_id: null,
    });
    const result = await buildCortexInstructionsInput(
      config,
      vaultDir,
      undefined,
      requestContext(vaultDir, projectId),
    );
    cleanup();
    expect(result.instruction).not.toContain('"op":"canopy_map"');
  });

  it('omits the myco_cortex canopy_map directive when Cortex is disabled, even with a populated map', async () => {
    const config = MycoConfigSchema.parse({ version: 3, cortex: { instructions: { inject_on_session_start: false } } });
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'default-agent', created_at: NOW });

    const { vaultDir, machineId, projectId, cleanup } = makeVaultDir();
    writeCanopyMap({
      project_id: projectId,
      machine_id: machineId,
      content: '## Map\n',
      inputs_hash: 'h-disabled',
      token_estimate: 10,
      generated_by_run_id: null,
    });
    const result = await buildCortexInstructionsInput(
      config,
      vaultDir,
      undefined,
      requestContext(vaultDir, projectId),
    );
    cleanup();
    expect(result.instruction).not.toContain('"op":"canopy_map"');
  });
});
