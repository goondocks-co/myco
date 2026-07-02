import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent, listRunEvents } from '@myco/db/queries/agent-run-events.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}

describe('agent-run-events queries', () => {
  beforeEach(() => {
    setupTestDb();
    createAgent('agent-1');
    insertRun({ id: 'run-1', agent_id: 'agent-1', status: 'running', started_at: epochNow() });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('inserts a row and returns the autoincrement id', () => {
    const id = insertRunEvent({
      runId: 'run-1',
      eventType: 'phase_start',
      phaseName: 'gather',
      payload: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('lists events for a run ordered by id ascending', () => {
    insertRunEvent({ runId: 'run-1', eventType: 'phase_start', phaseName: 'gather' });
    insertRunEvent({ runId: 'run-1', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_spores' });
    insertRunEvent({ runId: 'run-1', eventType: 'post_tool_use', phaseName: 'gather', toolName: 'vault_spores', outcome: 'success', durationMs: 12 });

    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event_type)).toEqual(['phase_start', 'pre_tool_use', 'post_tool_use']);
    expect(events[2].tool_name).toBe('vault_spores');
    expect(events[2].outcome).toBe('success');
    expect(events[2].duration_ms).toBe(12);
  });

  it('supports sinceId cursor-based polling — only returns rows with id > sinceId', () => {
    const firstId = insertRunEvent({ runId: 'run-1', eventType: 'phase_start', phaseName: 'gather' });
    insertRunEvent({ runId: 'run-1', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_spores' });

    const events = listRunEvents('run-1', { sinceId: firstId, scope: ALL_PROJECTS_SCOPE });
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('pre_tool_use');
  });

  it('parses the JSON payload column back into an object, degrading to null on parse failure', () => {
    insertRunEvent({ runId: 'run-1', eventType: 'phase_end', phaseName: 'gather', payload: JSON.stringify({ turnsUsed: 3 }) });
    const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
    expect(events[0].payload).toEqual({ turnsUsed: 3 });
  });

  it('returns an empty array for a run with no events', () => {
    insertRun({ id: 'run-2', agent_id: 'agent-1', status: 'running', started_at: epochNow() });
    const events = listRunEvents('run-2', { scope: ALL_PROJECTS_SCOPE });
    expect(events).toEqual([]);
  });
});
