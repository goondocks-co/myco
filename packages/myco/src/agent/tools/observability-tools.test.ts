import { describe, expect, test, beforeEach } from 'bun:test';
import { withDatabase, openDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { listReports } from '@myco/db/queries/reports.js';
import { epochSeconds } from '@myco/constants.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { createObservabilityTools } from './observability-tools.js';
import type { VaultToolDeps } from './types.js';

/**
 * Coverage for vault_report's server-side spores_created stamping. Drives
 * a real in-memory SQLite instance through insertRunEvent/insertReport
 * rather than mocking the query layer, matching the sibling
 * phase-postconditions.vault-seed.test.ts convention.
 */
describe('vault_report spores_created stamping', () => {
  let db: Database;
  const agentId = 'test-agent';
  const runId = 'test-run-1';
  const projectId = assertGroveProjectId(createProjectId());

  beforeEach(() => {
    db = openDatabase(':memory:');
    createSchema(db);
    withDatabase(db, () => {
      registerAgent({ id: agentId, name: 'Test Agent', created_at: epochSeconds() });
      insertRun({ id: runId, agent_id: agentId, project_id: projectId });
    });
  });

  function deps(): VaultToolDeps {
    const requestContext: MycoRequestContext = {
      projectRoot: '/tmp/test-project',
      callerRoot: null,
      projectId,
      groveId: null,
      machineId: 'test-machine',
      sessionId: null,
      projectVaultDir: '/tmp/test-project/.myco',
      databasePath: ':memory:',
      source: 'explicit',
      tenancySource: 'caller',
    };
    return {
      agentId,
      runId,
      requestContext,
      recordTurn: () => null,
    };
  }

  async function callVaultReport(args: { action: string; summary: string; details?: Record<string, unknown> }) {
    const [vaultReport] = createObservabilityTools(deps());
    return (vaultReport as unknown as { handler: (args: unknown, extra: unknown) => Promise<unknown> }).handler(args, {});
  }

  test('stamps the authoritative count when details carries spores_created', () => {
    withDatabase(db, async () => {
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
        outcome: 'success',
      });
      insertRunEvent({
        runId,
        phaseName: 'seed-spores',
        eventType: 'post_tool_use',
        toolName: 'vault_create_spore',
        outcome: 'error',
      });

      await callVaultReport({
        action: 'complete',
        summary: 'seeded',
        details: { spores_created: 999, spores_by_type: { pattern: 1 } },
      });

      const reports = listReports(runId, { scope: { kind: 'project', id: projectId } });
      expect(reports).toHaveLength(1);
      const details = JSON.parse(reports[0]!.details!) as Record<string, unknown>;
      expect(details.spores_created).toBe(2);
      expect(details.spores_by_type).toEqual({ pattern: 1 });
    });
  });

  test('stores a report without the key untouched (no query, no added key)', () => {
    withDatabase(db, async () => {
      await callVaultReport({
        action: 'skip',
        summary: 'vault already populated',
        details: { reason: 'already seeded' },
      });

      const reports = listReports(runId, { scope: { kind: 'project', id: projectId } });
      expect(reports).toHaveLength(1);
      const details = JSON.parse(reports[0]!.details!) as Record<string, unknown>;
      expect(details).toEqual({ reason: 'already seeded' });
      expect('spores_created' in details).toBe(false);
    });
  });

  test('stores a report with no details at all untouched', () => {
    withDatabase(db, async () => {
      await callVaultReport({ action: 'skip', summary: 'no details' });

      const reports = listReports(runId, { scope: { kind: 'project', id: projectId } });
      expect(reports).toHaveLength(1);
      expect(reports[0]!.details).toBeNull();
    });
  });
});
