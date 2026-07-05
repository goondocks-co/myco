import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { epochSeconds } from '@myco/constants.js';
import { checkPhasePostCondition, type PhasePostConditionInput } from './phase-postconditions.js';

/**
 * Coverage for the four vault-seed phase postconditions. Each check reads
 * `agent_run_events`, not `digest_extracts` (no run_id column). Tests
 * drive a real in-memory SQLite instance through insertRunEvent rather
 * than mocking the query layer.
 */
describe('vault-seed phase postconditions', () => {
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

  function input(overrides: Partial<PhasePostConditionInput> = {}): PhasePostConditionInput {
    return { runId, agentId, projectId: 'proj-1', dryRun: false, ...overrides };
  }

  describe('vault-seed-spores', () => {
    test('passes when seed-spores made a successful vault_create_spore call', () => {
      withDatabase(db, () => {
        insertRunEvent({
          runId,
          phaseName: 'seed-spores',
          eventType: 'post_tool_use',
          toolName: 'vault_create_spore',
          outcome: 'success',
        });
        const result = checkPhasePostCondition('vault-seed-spores', input());
        expect(result.passed).toBe(true);
      });
    });

    test('fails when seed-spores made zero tool calls (prose-only phase)', () => {
      withDatabase(db, () => {
        const result = checkPhasePostCondition('vault-seed-spores', input());
        expect(result.passed).toBe(false);
        expect(result.reason).toContain('seed-spores');
        expect(result.reason).toContain('vault_create_spore');
      });
    });

    test('fails when the only vault_create_spore call errored', () => {
      withDatabase(db, () => {
        insertRunEvent({
          runId,
          phaseName: 'seed-spores',
          eventType: 'post_tool_use',
          toolName: 'vault_create_spore',
          outcome: 'error',
        });
        const result = checkPhasePostCondition('vault-seed-spores', input());
        expect(result.passed).toBe(false);
      });
    });

    test('ignores calls from a different phase (phase-scoped, not just run-scoped)', () => {
      withDatabase(db, () => {
        insertRunEvent({
          runId,
          phaseName: 'digest-10000',
          eventType: 'post_tool_use',
          toolName: 'vault_create_spore',
          outcome: 'success',
        });
        const result = checkPhasePostCondition('vault-seed-spores', input());
        expect(result.passed).toBe(false);
      });
    });

    test('ignores calls from a different run (run-scoped)', () => {
      withDatabase(db, () => {
        registerAgent({ id: 'other-agent', name: 'Other Agent', created_at: epochSeconds() });
        insertRun({ id: 'other-run', agent_id: 'other-agent', project_id: 'proj-1' });
        insertRunEvent({
          runId: 'other-run',
          phaseName: 'seed-spores',
          eventType: 'post_tool_use',
          toolName: 'vault_create_spore',
          outcome: 'success',
        });
        const result = checkPhasePostCondition('vault-seed-spores', input());
        expect(result.passed).toBe(false);
      });
    });
  });

  describe('vault-seed-digest-10000 / -5000 / -1500', () => {
    const cases: Array<{ kind: 'vault-seed-digest-10000' | 'vault-seed-digest-5000' | 'vault-seed-digest-1500'; phase: string }> = [
      { kind: 'vault-seed-digest-10000', phase: 'digest-10000' },
      { kind: 'vault-seed-digest-5000', phase: 'digest-5000' },
      { kind: 'vault-seed-digest-1500', phase: 'digest-1500' },
    ];

    for (const { kind, phase } of cases) {
      test(`${kind} passes on a successful vault_write_digest call in "${phase}"`, () => {
        withDatabase(db, () => {
          insertRunEvent({
            runId,
            phaseName: phase,
            eventType: 'post_tool_use',
            toolName: 'vault_write_digest',
            outcome: 'success',
          });
          const result = checkPhasePostCondition(kind, input());
          expect(result.passed).toBe(true);
        });
      });

      test(`${kind} fails when "${phase}" made no vault_write_digest call`, () => {
        withDatabase(db, () => {
          const result = checkPhasePostCondition(kind, input());
          expect(result.passed).toBe(false);
          expect(result.reason).toContain(phase);
        });
      });
    }

    test('vault-seed-digest-10000 does NOT pass on a digest-5000 write (tier phases are not interchangeable)', () => {
      withDatabase(db, () => {
        insertRunEvent({
          runId,
          phaseName: 'digest-5000',
          eventType: 'post_tool_use',
          toolName: 'vault_write_digest',
          outcome: 'success',
        });
        const result = checkPhasePostCondition('vault-seed-digest-10000', input());
        expect(result.passed).toBe(false);
      });
    });
  });

  test('a completed report on the run does not by itself satisfy the digest checks (no digest_extracts fallback)', () => {
    withDatabase(db, () => {
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'complete',
        summary: 'seeded',
        created_at: epochSeconds(),
      });
      const result = checkPhasePostCondition('vault-seed-digest-10000', input());
      expect(result.passed).toBe(false);
    });
  });
});
