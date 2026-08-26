/**
 * Tests for buildAuditEventHooks — the default HarnessHooks implementation
 * that persists every lifecycle event to agent_run_events. Mirrors the
 * "best-effort, never throws" convention already used by recordTurn/
 * insertWriteIntent in tools.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { listRunEvents } from '@myco/db/queries/agent-run-events.js';
import { buildAuditEventHooks } from '@myco/agent/harness/audit-hooks.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { testRunStore } from '../../helpers/run-store';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}

describe('buildAuditEventHooks', () => {
  beforeEach(() => {
    setupTestDb();
    createAgent('agent-1');
    insertRun({ id: 'run-1', agent_id: 'agent-1', status: 'running', started_at: epochNow() });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('records a phaseStart event', async () => {
    const hooks = buildAuditEventHooks(testRunStore(undefined, 'myco-agent'), 'run-1', null);
    await hooks.phaseStart?.({
      runId: 'run-1', agentId: 'agent-1', harnessId: 'claude-sdk', phaseName: 'gather',
      model: 'claude-sonnet-4-6', maxTurns: 8, required: true,
    });
    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('phase_start');
    expect(events[0].phase_name).toBe('gather');
  });

  it('records a preToolUse event with tool_name set', async () => {
    const hooks = buildAuditEventHooks(testRunStore(undefined, 'myco-agent'), 'run-1', null);
    await hooks.preToolUse?.({
      runId: 'run-1', agentId: 'agent-1', harnessId: 'claude-sdk', phaseName: 'gather',
      toolName: 'vault_spores', toolInput: { limit: 5 },
    });
    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events[0].event_type).toBe('pre_tool_use');
    expect(events[0].tool_name).toBe('vault_spores');
  });

  it('records a postToolUse error event with outcome and errorMessage in payload', async () => {
    const hooks = buildAuditEventHooks(testRunStore(undefined, 'myco-agent'), 'run-1', null);
    await hooks.postToolUse?.({
      runId: 'run-1', agentId: 'agent-1', harnessId: 'openai-agents', phaseName: 'gather',
      toolName: 'vault_create_spore', toolInput: {}, outcome: 'error',
      errorMessage: 'insert failed', durationMs: 42,
    });
    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events[0].outcome).toBe('error');
    expect(events[0].duration_ms).toBe(42);
    expect(events[0].payload).toMatchObject({ errorMessage: 'insert failed' });
  });

  it('records a phaseEnd event with status and cost fields', async () => {
    const hooks = buildAuditEventHooks(testRunStore(undefined, 'myco-agent'), 'run-1', null);
    await hooks.phaseEnd?.({
      runId: 'run-1', agentId: 'agent-1', harnessId: 'claude-sdk', phaseName: 'gather',
      status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.02, durationMs: 900,
    });
    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events[0].event_type).toBe('phase_end');
    expect(events[0].payload).toMatchObject({ status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.02 });
  });

  it('never throws when insertRunEvent fails — best-effort like recordTurn/insertWriteIntent', async () => {
    // Force a DB error by referencing a run_id that violates the FK constraint
    // (agent_run_events.run_id REFERENCES agent_runs(id)), for all four
    // hooks — each calls insertRunEvent independently, so each needs its
    // own best-effort guard verified, not just phaseStart's.
    const hooks = buildAuditEventHooks(testRunStore(undefined, 'myco-agent'), 'nonexistent-run', null);
    const baseEvent = {
      runId: 'nonexistent-run', agentId: 'agent-1', harnessId: 'claude-sdk' as const, phaseName: 'gather',
    };

    await expect(
      hooks.phaseStart?.({
        ...baseEvent, model: 'claude-sonnet-4-6', required: true,
      }),
    ).resolves.toBeUndefined();

    await expect(
      hooks.preToolUse?.({
        ...baseEvent, toolName: 'vault_spores', toolInput: { limit: 5 },
      }),
    ).resolves.toBeUndefined();

    await expect(
      hooks.postToolUse?.({
        ...baseEvent, toolName: 'vault_create_spore', toolInput: {}, outcome: 'error',
        errorMessage: 'insert failed', durationMs: 42,
      }),
    ).resolves.toBeUndefined();

    await expect(
      hooks.phaseEnd?.({
        ...baseEvent, status: 'completed', turnsUsed: 3, tokensUsed: 500, costUsd: 0.02, durationMs: 900,
      }),
    ).resolves.toBeUndefined();

    expect(listRunEvents('nonexistent-run', { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });
});
