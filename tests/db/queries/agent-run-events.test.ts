import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { epochSeconds } from '@myco/constants.js';
import {
  countPhaseToolCallsByOutcome,
  countRunToolCallsByOutcome,
  insertRunEvent,
} from '@myco/db/queries/agent-run-events.js';

describe('countRunToolCallsByOutcome', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'test-run-1';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: 'proj-1' });
    });
  });

  test('counts successful calls for a tool, run-scoped across phases', () => {
    withDatabase(db, () => {
      insertRunEvent({
        runId,
        phaseName: 'seed-spores',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'success',
      });
      insertRunEvent({
        runId,
        phaseName: 'digest-10000',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'success',
      });
      const count = countRunToolCallsByOutcome(runId, 'vault_create_spore', 'success');
      expect(count).toBe(2);
    });
  });

  test('counts error calls separately from success calls', () => {
    withDatabase(db, () => {
      insertRunEvent({
        runId,
        phaseName: 'seed-spores',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'success',
      });
      insertRunEvent({
        runId,
        phaseName: 'seed-spores',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'error',
      });
      expect(countRunToolCallsByOutcome(runId, 'vault_create_spore', 'success')).toBe(1);
      expect(countRunToolCallsByOutcome(runId, 'vault_create_spore', 'error')).toBe(1);
    });
  });

  test('is not scoped to a single phase, unlike countPhaseToolCallsByOutcome', () => {
    withDatabase(db, () => {
      insertRunEvent({
        runId,
        phaseName: 'seed-spores',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'success',
      });
      insertRunEvent({
        runId,
        phaseName: 'digest-10000',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'success',
      });

      expect(countPhaseToolCallsByOutcome(runId, 'seed-spores', 'vault_create_spore', 'success')).toBe(1);
      expect(countPhaseToolCallsByOutcome(runId, 'digest-10000', 'vault_create_spore', 'success')).toBe(1);
      expect(countRunToolCallsByOutcome(runId, 'vault_create_spore', 'success')).toBe(2);
    });
  });

  test('returns 0 when no matching events exist', () => {
    withDatabase(db, () => {
      expect(countRunToolCallsByOutcome(runId, 'vault_create_spore', 'success')).toBe(0);
    });
  });
});
