/**
 * Tests for the run-health aggregate query helpers backing
 * `vault_run_health`. Each bucket is exercised against a real in-memory
 * SQLite database: seed the anomaly shape, assert the detector finds it;
 * seed clean data, assert the detector stays empty.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import {
  findCapHits,
  findCostSpikes,
  findFlagClusters,
  findPostConditionFailures,
  findSilentStreams,
  findUnpairedEvents,
  findZeroUsageRuns,
  resolveRunHealthWindow,
} from '@myco/db/queries/run-health.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'agent-run-health-test';

function seedRun(id: string, overrides: Parameters<typeof insertRun>[0] = { id, agent_id: TEST_AGENT_ID }) {
  return insertRun({
    id,
    agent_id: TEST_AGENT_ID,
    started_at: epochNow(),
    ...overrides,
  });
}

describe('run-health query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  // -------------------------------------------------------------------------
  // 1. unpaired_events
  // -------------------------------------------------------------------------

  describe('findUnpairedEvents', () => {
    it('detects a run whose pre/post tool-use counts differ', () => {
      seedRun('run-unpaired');
      insertRunEvent({ runId: 'run-unpaired', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_spores' });
      // No matching post_tool_use — simulates a process death mid-tool.

      const window = resolveRunHealthWindow(24);
      const found = findUnpairedEvents(window, ALL_PROJECTS_SCOPE, 'run-caller');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ run_id: 'run-unpaired', tool_name: 'vault_spores', pre_count: 1, post_count: 0 });
    });

    it('stays empty when every pre_tool_use has a matching post_tool_use', () => {
      seedRun('run-paired');
      insertRunEvent({ runId: 'run-paired', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_spores' });
      insertRunEvent({ runId: 'run-paired', eventType: 'post_tool_use', phaseName: 'gather', toolName: 'vault_spores', outcome: 'success' });

      const window = resolveRunHealthWindow(24);
      expect(findUnpairedEvents(window, ALL_PROJECTS_SCOPE, 'run-caller')).toHaveLength(0);
    });

    it('counts an error-outcome post_tool_use as paired, not unpaired', () => {
      seedRun('run-tool-error');
      insertRunEvent({ runId: 'run-tool-error', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_spores' });
      insertRunEvent({ runId: 'run-tool-error', eventType: 'post_tool_use', phaseName: 'gather', toolName: 'vault_spores', outcome: 'error' });

      const window = resolveRunHealthWindow(24);
      expect(findUnpairedEvents(window, ALL_PROJECTS_SCOPE, 'run-caller')).toHaveLength(0);
    });

    // Mandatory regression test for the sentinel self-observation false
    // positive: the audit wrapper inserts pre_tool_use synchronously before
    // the handler runs, so the CALLING run's own in-flight vault_run_health
    // call would otherwise always appear as a pre=1/post=0 unpaired group.
    it('excludes an in-flight pre_tool_use event under the CALLING run id', () => {
      seedRun('run-self-observing');
      insertRunEvent({ runId: 'run-self-observing', eventType: 'pre_tool_use', phaseName: 'assess', toolName: 'vault_run_health' });
      // No matching post_tool_use yet — this IS the in-flight call.

      const window = resolveRunHealthWindow(24);
      const found = findUnpairedEvents(window, ALL_PROJECTS_SCOPE, 'run-self-observing');
      expect(found).toHaveLength(0);
    });

    it('still detects the same unpaired shape under a DIFFERENT run id', () => {
      seedRun('run-other-in-flight');
      insertRunEvent({ runId: 'run-other-in-flight', eventType: 'pre_tool_use', phaseName: 'assess', toolName: 'vault_run_health' });
      // No matching post_tool_use — a genuinely different run's in-flight call.

      const window = resolveRunHealthWindow(24);
      const found = findUnpairedEvents(window, ALL_PROJECTS_SCOPE, 'run-self-observing');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ run_id: 'run-other-in-flight', tool_name: 'vault_run_health', pre_count: 1, post_count: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // 2. cap_hits / postcondition_failures
  // -------------------------------------------------------------------------

  describe('findCapHits / findPostConditionFailures', () => {
    it('detects a phase with capHit true in actions_taken JSON', () => {
      seedRun('run-cap-hit');
      getDatabase().prepare(`UPDATE agent_runs SET actions_taken = ? WHERE id = ?`).run(
        JSON.stringify({
          harness: 'claude-sdk',
          model: 'sonnet',
          provider: 'anthropic',
          phases: [{ name: 'gather', status: 'failed', turnsUsed: 20, tokensUsed: 500, costUsd: 0, capHit: true, summary: 'ran out of turns' }],
        }),
        'run-cap-hit',
      );

      const window = resolveRunHealthWindow(24);
      const hits = findCapHits(window, ALL_PROJECTS_SCOPE);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ run_id: 'run-cap-hit', phase_name: 'gather' });
      expect(findPostConditionFailures(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });

    it('detects a phase with postConditionFailed true, including on a failure-path record', () => {
      seedRun('run-postcondition');
      getDatabase().prepare(`UPDATE agent_runs SET actions_taken = ?, status = ? WHERE id = ?`).run(
        JSON.stringify({
          harness: 'claude-sdk',
          model: 'sonnet',
          provider: 'anthropic',
          phases: [{ name: 'act', status: 'failed', turnsUsed: 5, tokensUsed: 200, costUsd: 0.01, postConditionFailed: true, summary: 'gate rejected' }],
        }),
        'failed',
        'run-postcondition',
      );

      const window = resolveRunHealthWindow(24);
      const failures = findPostConditionFailures(window, ALL_PROJECTS_SCOPE);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ run_id: 'run-postcondition', task: null, phase_name: 'act' });
      expect(findCapHits(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });

    it('stays empty when actions_taken has phases with no true flags', () => {
      seedRun('run-clean-phases');
      getDatabase().prepare(`UPDATE agent_runs SET actions_taken = ? WHERE id = ?`).run(
        JSON.stringify({
          harness: 'claude-sdk',
          model: 'sonnet',
          provider: 'anthropic',
          phases: [{ name: 'gather', status: 'completed', turnsUsed: 3, tokensUsed: 100, costUsd: 0.001, summary: 'ok' }],
        }),
        'run-clean-phases',
      );

      const window = resolveRunHealthWindow(24);
      expect(findCapHits(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
      expect(findPostConditionFailures(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });

    it('stays empty when actions_taken is NULL', () => {
      seedRun('run-no-actions');
      const window = resolveRunHealthWindow(24);
      expect(findCapHits(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
      expect(findPostConditionFailures(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. cost_spikes
  // -------------------------------------------------------------------------

  describe('findCostSpikes', () => {
    it('detects a (task, provider) pair whose window mean exceeds the trailing mean by the ratio', () => {
      const now = epochNow();
      const window = resolveRunHealthWindow(24, now);
      const trailingMid = window.startedAfter - 12 * 3600;

      // Trailing window baseline: mean cost 0.01
      seedRun('run-trail-1', { id: 'run-trail-1', agent_id: TEST_AGENT_ID, task: 'vault-evolve', provider: 'anthropic', cost_usd: 0.01, started_at: trailingMid });
      // Current window: mean cost 0.05 (5x)
      seedRun('run-spike-1', { id: 'run-spike-1', agent_id: TEST_AGENT_ID, task: 'vault-evolve', provider: 'anthropic', cost_usd: 0.05, started_at: now - 60 });

      const spikes = findCostSpikes(window, ALL_PROJECTS_SCOPE, 2);
      expect(spikes).toHaveLength(1);
      expect(spikes[0]).toMatchObject({ task: 'vault-evolve', provider: 'anthropic' });
      expect(spikes[0].ratio).toBeGreaterThanOrEqual(2);
    });

    it('excludes zero-cost rows (local providers) from both means', () => {
      const now = epochNow();
      const window = resolveRunHealthWindow(24, now);
      const trailingMid = window.startedAfter - 12 * 3600;

      seedRun('run-trail-zero', { id: 'run-trail-zero', agent_id: TEST_AGENT_ID, task: 'skill-evolve', provider: 'ollama', cost_usd: 0, started_at: trailingMid });
      seedRun('run-window-zero', { id: 'run-window-zero', agent_id: TEST_AGENT_ID, task: 'skill-evolve', provider: 'ollama', cost_usd: 0, started_at: now - 60 });

      const spikes = findCostSpikes(window, ALL_PROJECTS_SCOPE, 2);
      expect(spikes).toHaveLength(0);
    });

    it('stays empty when the ratio does not clear the threshold', () => {
      const now = epochNow();
      const window = resolveRunHealthWindow(24, now);
      const trailingMid = window.startedAfter - 12 * 3600;

      seedRun('run-trail-flat', { id: 'run-trail-flat', agent_id: TEST_AGENT_ID, task: 'cortex-instructions', provider: 'anthropic', cost_usd: 0.02, started_at: trailingMid });
      seedRun('run-window-flat', { id: 'run-window-flat', agent_id: TEST_AGENT_ID, task: 'cortex-instructions', provider: 'anthropic', cost_usd: 0.022, started_at: now - 60 });

      expect(findCostSpikes(window, ALL_PROJECTS_SCOPE, 2)).toHaveLength(0);
    });

    it('stays empty when there is no trailing baseline to compare against', () => {
      const window = resolveRunHealthWindow(24);
      seedRun('run-no-baseline', { id: 'run-no-baseline', agent_id: TEST_AGENT_ID, task: 'vault-evolve', provider: 'anthropic', cost_usd: 0.05, started_at: epochNow() - 60 });
      expect(findCostSpikes(window, ALL_PROJECTS_SCOPE, 2)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. flag_clusters
  // -------------------------------------------------------------------------

  describe('findFlagClusters', () => {
    it('finds a write intent with classifier_verdict = flag', () => {
      seedRun('run-flag', { id: 'run-flag', agent_id: TEST_AGENT_ID, task: 'vault-evolve' });
      insertWriteIntent({
        runId: 'run-flag',
        toolName: 'vault_create_spore',
        toolInput: '{}',
        syntheticOutput: '{}',
        classifierVerdict: 'flag',
        classifierReason: 'looked destructive',
      });

      const window = resolveRunHealthWindow(24);
      const clusters = findFlagClusters(window, ALL_PROJECTS_SCOPE);
      expect(clusters).toHaveLength(1);
      expect(clusters[0]).toMatchObject({ run_id: 'run-flag', task: 'vault-evolve', tool_name: 'vault_create_spore', classifier_reason: 'looked destructive' });
    });

    it('excludes dry-run-intercepted intents with a null verdict', () => {
      seedRun('run-dry-run', { id: 'run-dry-run', agent_id: TEST_AGENT_ID, task: 'vault-evolve' });
      insertWriteIntent({
        runId: 'run-dry-run',
        toolName: 'vault_mark_processed',
        toolInput: '{}',
        syntheticOutput: '{}',
      });

      const window = resolveRunHealthWindow(24);
      expect(findFlagClusters(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. zero_usage
  // -------------------------------------------------------------------------

  describe('findZeroUsageRuns', () => {
    it('detects a completed run with tokens_used = 0', () => {
      seedRun('run-zero-completed', { id: 'run-zero-completed', agent_id: TEST_AGENT_ID, task: 'title-summary', status: 'completed', tokens_used: 0 });

      const window = resolveRunHealthWindow(24);
      const found = findZeroUsageRuns(window, ALL_PROJECTS_SCOPE);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ run_id: 'run-zero-completed', task: 'title-summary', status: 'completed' });
    });

    it('detects a failed run with all-zero usage telemetry', () => {
      seedRun('run-zero-failed', { id: 'run-zero-failed', agent_id: TEST_AGENT_ID, task: 'title-summary', status: 'failed', tokens_used: 0, cost_usd: 0 });

      const window = resolveRunHealthWindow(24);
      const found = findZeroUsageRuns(window, ALL_PROJECTS_SCOPE);
      expect(found).toHaveLength(1);
      expect(found[0].status).toBe('failed');
    });

    it('excludes a failed run that recorded partial usage before failing', () => {
      seedRun('run-partial-failed', { id: 'run-partial-failed', agent_id: TEST_AGENT_ID, task: 'title-summary', status: 'failed', tokens_used: 150, cost_usd: 0.002 });

      const window = resolveRunHealthWindow(24);
      expect(findZeroUsageRuns(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });

    it('excludes a completed run with nonzero token usage', () => {
      seedRun('run-normal-completed', { id: 'run-normal-completed', agent_id: TEST_AGENT_ID, task: 'title-summary', status: 'completed', tokens_used: 400 });

      const window = resolveRunHealthWindow(24);
      expect(findZeroUsageRuns(window, ALL_PROJECTS_SCOPE)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. silent_streams
  // -------------------------------------------------------------------------

  describe('findSilentStreams', () => {
    it('flags a schedule-enabled, preCondition-free task with zero runs in the window', () => {
      // canopy-map is bundled with schedule.enabled=true and no preCondition.
      const window = resolveRunHealthWindow(24);
      const silent = findSilentStreams(window, ALL_PROJECTS_SCOPE);
      expect(silent.some((s) => s.task === 'canopy-map')).toBe(true);
    });

    it('does not flag that task once it has a run in the window', () => {
      seedRun('run-canopy-map', { id: 'run-canopy-map', agent_id: TEST_AGENT_ID, task: 'canopy-map' });

      const window = resolveRunHealthWindow(24);
      const silent = findSilentStreams(window, ALL_PROJECTS_SCOPE);
      expect(silent.some((s) => s.task === 'canopy-map')).toBe(false);
    });

    it('never flags a task that has a preCondition gate', () => {
      // skill-generate ships with schedule.enabled=false; vault-evolve/skill-survey
      // ship enabled=true but WITH a preCondition — neither should ever appear.
      const window = resolveRunHealthWindow(24);
      const silent = findSilentStreams(window, ALL_PROJECTS_SCOPE);
      expect(silent.some((s) => s.task === 'skill-generate')).toBe(false);
      expect(silent.some((s) => s.task === 'vault-evolve')).toBe(false);
      expect(silent.some((s) => s.task === 'skill-survey')).toBe(false);
    });
  });
});
