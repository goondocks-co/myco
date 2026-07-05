import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { epochSeconds } from '@myco/constants.js';
import { validateTaskPostconditions } from './task-postconditions.js';

/**
 * Run-end validator coverage for vault-seed's skip-XOR-seed contract.
 * Synthetic event/turn/report fixtures exercise both accepted shapes plus
 * the failure modes the validator exists to catch.
 */
describe('validateTaskPostconditions — vault-seed', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'vault-seed-run-1';
  const taskName = 'vault-seed';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: 'proj-1' });
    });
  });

  function createSporeTurn(index: number): void {
    insertTurn({
      run_id: runId,
      agent_id: agentId,
      turn_number: index,
      tool_name: 'vault_create_spore',
    });
  }

  function writeDigestEvent(phase: string): void {
    insertRunEvent({
      runId,
      phaseName: phase,
      eventType: 'post_tool_use',
      toolName: 'vault_write_digest',
      outcome: 'success',
    });
  }

  test('SKIP path passes: skip report present, zero create calls', () => {
    withDatabase(db, () => {
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'skip',
        summary: 'vault already populated',
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).toBeNull();
    });
  });

  test('SKIP path fails: skip report present but creates happened anyway', () => {
    withDatabase(db, () => {
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'skip',
        summary: 'vault already populated',
        created_at: epochSeconds(),
      });
      createSporeTurn(1);
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('skip');
    });
  });

  test('SEED path passes: creates >=1, all three digest kinds satisfied, matching complete report', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      createSporeTurn(2);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      writeDigestEvent('digest-1500');
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'complete',
        summary: 'seeded',
        details: JSON.stringify({ spores_created: 2 }),
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).toBeNull();
    });
  });

  test('SEED path fails: creates happened but a digest tier never wrote', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      // digest-1500 never called vault_write_digest.
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'complete',
        summary: 'seeded',
        details: JSON.stringify({ spores_created: 1 }),
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('digest-1500');
    });
  });

  test('SEED path fails: no complete report even though creates + digests happened', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      writeDigestEvent('digest-1500');
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('complete');
    });
  });

  test('SEED path fails: reported spore count does not match the run-scoped create count (retires the 19-vs-18 drift)', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      createSporeTurn(2);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      writeDigestEvent('digest-1500');
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'complete',
        summary: 'seeded',
        details: JSON.stringify({ spores_created: 19 }),
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('19');
      expect(error).toContain('2');
    });
  });

  test('SEED path fails: complete report omits the numeric spores_created count', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      writeDigestEvent('digest-1500');
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'complete',
        summary: 'seeded',
        details: JSON.stringify({ themes: 8 }),
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('spores_created');
    });
  });

  test('fails outright: no report at all', () => {
    withDatabase(db, () => {
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('vault_report');
    });
  });

  test('fails: creates happened but neither a skip nor complete report exists', () => {
    withDatabase(db, () => {
      createSporeTurn(1);
      writeDigestEvent('digest-10000');
      writeDigestEvent('digest-5000');
      writeDigestEvent('digest-1500');
      insertReport({
        run_id: runId,
        agent_id: agentId,
        action: 'orient',
        summary: 'themes found',
        created_at: epochSeconds(),
      });
      const error = validateTaskPostconditions({ runId, taskName });
      expect(error).not.toBeNull();
      expect(error).toContain('complete');
    });
  });

  test('other task names are unaffected by the vault-seed rule', () => {
    withDatabase(db, () => {
      const error = validateTaskPostconditions({ runId, taskName: 'some-other-task' });
      expect(error).toBeNull();
    });
  });
});
