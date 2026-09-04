import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { epochSeconds } from '@myco/constants.js';
import { validateTaskPostconditions } from '@myco/agent/task-postconditions.js';

/**
 * Run-end validator coverage for the sweep's contract: the run closes with a
 * `supersession` report, and a report claiming zero resolutions while the
 * tool-call log shows one is the shape it rejects.
 *
 * This validator runs on the local executor, which holds the vault it reads.
 * A run on the Deployment's harness is held to the same report by the server
 * at run close (`core/run-postconditions.ts`), where the evidence lives.
 */
describe('validateTaskPostconditions — supersession-sweep', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'sweep-run-1';
  const taskName = 'supersession-sweep';

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: 'proj-1' });
    });
  });

  function report(details: Record<string, unknown> | null, action = 'supersession'): void {
    insertReport({
      run_id: runId,
      agent_id: agentId,
      action,
      summary: 'swept',
      details: details === null ? undefined : JSON.stringify(details),
      created_at: epochSeconds(),
    });
  }

  function resolveTurn(index: number): void {
    insertTurn({ run_id: runId, agent_id: agentId, turn_number: index, tool_name: 'vault_resolve_spore' });
  }

  test('a run that resolved nothing passes on its report alone', () => {
    withDatabase(db, () => {
      report({ reviewed: 12, superseded: 0, consolidated: 0, obsoleted: 0 });
      expect(validateTaskPostconditions({ runId, taskName })).toBeNull();
    });
  });

  test('a run that resolved and said so passes', () => {
    withDatabase(db, () => {
      report({ reviewed: 12, superseded: 2, consolidated: 3, obsoleted: 0 });
      resolveTurn(1);
      resolveTurn(2);
      expect(validateTaskPostconditions({ runId, taskName })).toBeNull();
    });
  });

  test('a run without a supersession report fails, whatever else it reported', () => {
    withDatabase(db, () => {
      report({ reviewed: 4 }, 'summary');
      expect(validateTaskPostconditions({ runId, taskName }))
        .toBe('supersession-sweep completed without a vault_report with action "supersession"');
    });
  });

  test('a run with no report at all fails', () => {
    withDatabase(db, () => {
      expect(validateTaskPostconditions({ runId, taskName }))
        .toBe('supersession-sweep completed without a vault_report with action "supersession"');
    });
  });

  test('a report claiming zero while a resolution landed fails', () => {
    withDatabase(db, () => {
      report({ reviewed: 12, superseded: 0, consolidated: 0, obsoleted: 0 });
      resolveTurn(1);
      expect(validateTaskPostconditions({ runId, taskName }))
        .toBe('supersession-sweep reported zero resolutions but 1 vault_resolve_spore call(s) were made this run');
    });
  });

  test('a report carrying no counts passes: the counts are what the check reads', () => {
    withDatabase(db, () => {
      report(null);
      resolveTurn(1);
      expect(validateTaskPostconditions({ runId, taskName })).toBeNull();
    });
  });

  test('a dry run is not held to the contract', () => {
    withDatabase(db, () => {
      expect(validateTaskPostconditions({ runId, taskName, dryRun: true })).toBeNull();
    });
  });
});
