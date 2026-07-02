/**
 * End-to-end integration test: runAgent() with a phased task, using a
 * stubbed harness that actually invokes a vault tool through the same
 * tool surface the phase loop builds (so tools.ts's hook emission fires
 * for real, via wrapToolWithAudit), and asserts agent_run_events contains
 * the full expected event sequence: phase_start -> pre_tool_use ->
 * post_tool_use -> phase_end, in that order, for a single-phase task.
 *
 * ADAPTATION FROM THE BRIEF'S SKETCH (see task-11-report.md for the
 * evidence trail):
 *  - The brief's fakeHarness only *constructed* a tool server
 *    (`createVaultToolServer(...)`) and never invoked a tool handler.
 *    Constructing the server wraps each tool's handler with
 *    wrapToolWithAudit, but wrapping alone never calls the wrapped
 *    function — no preToolUse/postToolUse would ever fire, which would
 *    make this "integration" test assert nothing about real tool-hook
 *    emission. This version calls `createVaultTools(...)` directly (the
 *    same factory `createVaultToolServer` wraps) and invokes the
 *    `vault_report` tool's `.handler()` — the same call shape
 *    tests/agent/tools-hooks.test.ts uses to prove hook emission at the
 *    unit level. That is what makes preToolUse/postToolUse fire for real
 *    here.
 *  - `title-summary` (the brief's suggested task) has no `phases` array —
 *    it is a single-query task, so it never reaches `executePhase` and
 *    therefore never emits phase_start/phase_end (Task 8's contract).
 *    Its postcondition validator also requires a real vault_update_session
 *    call or an explicit skip report to reach `status: 'completed'`.
 *    `cortex-prompt-builder` is used instead: it has exactly one phase
 *    ("build"), no task-specific postcondition validator, and its phase's
 *    `tools:` list includes `vault_report`, which is FK-safe to call (only
 *    needs an existing agent_runs row, which runAgent creates) and exempt
 *    from dry-run interception.
 *  - `ensureProjectManifest` requires an `options.projectName` (not
 *    optional as the brief's snippet showed) — supplied here, matching
 *    tests/agent/executor-hooks.test.ts's convention.
 *  - Request context is built via `makeTestRequestContext` (Task 7's
 *    fixture), not a hand-rolled partial-shape object, so `runAgent`'s
 *    scope resolution and DB path resolution get a real, complete
 *    `MycoRequestContext`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { setupTestDb, teardownTestDb } from '../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { epochSeconds, DEFAULT_AGENT_ID } from '@myco/constants.js';
import { makeTestRequestContext } from '../helpers/request-context';
import { listRunEvents } from '@myco/db/queries/agent-run-events.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { AgentHarness, HarnessExecuteInput, HarnessExecuteResult } from '@myco/agent/harness/types.js';
import type { HarnessId } from '@myco/agent/types.js';

// A stub harness that, when the phase loop calls execute(), actually
// invokes the `vault_report` tool through the real vault tool factory —
// simulating what a real SDK would do when the model decides to call a
// tool. This exercises tools.ts's hook emission (wrapToolWithAudit)
// without needing a real Claude/OpenAI SDK call.
const fakeHarness: AgentHarness = {
  id: 'claude-sdk' as HarnessId,
  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    const { createVaultTools } = await import('@myco/agent/tools.js');
    // Rebuild the same tool surface the phase loop passed in, so the
    // returned tool definitions are wrapped with wrapToolWithAudit
    // (preToolUse/postToolUse) using the run's real hooks/hookContext.
    const tools = createVaultTools(input.toolSurface.agentId, input.toolSurface.runId, {
      requestContext: input.toolSurface.requestContext,
      hooks: input.toolSurface.hooks,
      hookContext: input.toolSurface.hookContext,
    } as any);

    const vaultReport = tools.find((t) => t.name === 'vault_report');
    if (!vaultReport) {
      throw new Error('vault_report tool not found on toolSurface — cortex-prompt-builder phase tools may have drifted');
    }
    // Actually call the handler — this is what makes wrapToolWithAudit's
    // preToolUse/postToolUse fire for real, not just wrap-and-discard.
    await (vaultReport as any).handler(
      { action: 'cortex_prompt_builder', summary: 'test-generated prompt', details: { prompt: 'final prompt text' } },
      {},
    );

    return {
      finalText: 'phase complete',
      turnsUsed: 1,
      usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20, reasoningTokens: 0, cachedTokens: 0, durationMs: 5 },
      sessionRef: 'session-1',
    };
  },
  supports: () => false,
  classifyError: () => 'unknown',
};

mock.module('@myco/agent/harness/index.js', () => ({
  getAgentHarness: () => fakeHarness,
}));

describe('harness hooks — end-to-end integration', () => {
  let tmpDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hooks-e2e-'));
    ensureProjectManifest(tmpDir, { projectName: 'hooks-integration-test' });
    const now = epochSeconds();
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: `agent-${DEFAULT_AGENT_ID}`,
      created_at: now,
      updated_at: now,
    });
  });

  it('records phase_start -> pre_tool_use -> post_tool_use -> phase_end in order for a real runAgent() call', async () => {
    const { runAgent } = await import('@myco/agent/executor.js');
    const vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

    const requestContext = makeTestRequestContext({
      vaultDir,
      groveId: null,
    });

    const result = await runAgent(vaultDir, {
      task: 'cortex-prompt-builder',
      instruction: 'test instruction',
      requestContext,
    });

    expect(result.status).toBe('completed');

    const events = listRunEvents(result.runId, { scope: ALL_PROJECTS_SCOPE });
    const eventTypes = events.map((e) => e.event_type);

    // Full expected sequence for a single-phase task whose phase invokes
    // exactly one tool: phase_start, pre_tool_use, post_tool_use, phase_end.
    expect(eventTypes).toEqual(['phase_start', 'pre_tool_use', 'post_tool_use', 'phase_end']);

    for (const event of events) {
      expect(event.run_id).toBe(result.runId);
      expect(event.recorded_at).toBeGreaterThan(0);
    }

    const [phaseStart, preToolUse, postToolUse, phaseEnd] = events;

    expect(phaseStart.phase_name).toBe('build');
    expect(preToolUse.phase_name).toBe('build');
    expect(preToolUse.tool_name).toBe('vault_report');
    expect(postToolUse.phase_name).toBe('build');
    expect(postToolUse.tool_name).toBe('vault_report');
    expect(postToolUse.outcome).toBe('success');
    expect(phaseEnd.phase_name).toBe('build');
  });
});
