import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun, pruneOldAgentRuns } from '@myco/db/queries/runs.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId;
const AGENT_ID = 'agent-run-retention-test';
const NOW = 1_800_000_000;

function count(table: string, where: string, ...params: unknown[]): number {
  return (getDatabase().prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,
  ).get(...params) as { n: number }).n;
}

function seedRun(
  id: string,
  projectId: GroveProjectId,
  status: string,
  ageSeconds: number,
  resumable = 0,
): void {
  const completedAt = NOW - ageSeconds;
  insertRun({
    id,
    project_id: projectId,
    agent_id: AGENT_ID,
    task: 'retention-test',
    status,
    resumable,
    started_at: completedAt - 5,
    completed_at: status === 'running' || status === 'pending' ? null : completedAt,
  });
}

describe('agent run retention queries', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({
      id: AGENT_ID,
      name: 'Agent Run Retention Test',
      created_at: NOW,
    });
  });

  it('prunes old terminal non-resumable runs within scope and preserves active or resumable rows', () => {
    seedRun('old-completed-a', PROJECT_A, 'completed', 90_000);
    seedRun('old-failed-a', PROJECT_A, 'failed', 90_000);
    seedRun('old-skipped-a', PROJECT_A, 'skipped', 90_000);
    seedRun('new-completed-a', PROJECT_A, 'completed', 60);
    seedRun('old-resumable-a', PROJECT_A, 'failed', 90_000, 1);
    seedRun('old-running-a', PROJECT_A, 'running', 90_000);
    seedRun('old-pending-a', PROJECT_A, 'pending', 90_000);
    seedRun('old-completed-b', PROJECT_B, 'completed', 90_000);

    expect(pruneOldAgentRuns(86_400, projectScope(PROJECT_A), NOW)).toBe(3);

    expect(count('agent_runs', 'id = ?', 'old-completed-a')).toBe(0);
    expect(count('agent_runs', 'id = ?', 'old-failed-a')).toBe(0);
    expect(count('agent_runs', 'id = ?', 'old-skipped-a')).toBe(0);
    expect(count('agent_runs', 'id = ?', 'new-completed-a')).toBe(1);
    expect(count('agent_runs', 'id = ?', 'old-resumable-a')).toBe(1);
    expect(count('agent_runs', 'id = ?', 'old-running-a')).toBe(1);
    expect(count('agent_runs', 'id = ?', 'old-pending-a')).toBe(1);
    expect(count('agent_runs', 'id = ?', 'old-completed-b')).toBe(1);

    expect(pruneOldAgentRuns(86_400, ALL_PROJECTS_SCOPE, NOW)).toBe(1);
    expect(count('agent_runs', 'id = ?', 'old-completed-b')).toBe(0);
  });

  it('removes run audit children and nulls soft durable run references', () => {
    seedRun('old-run', PROJECT_A, 'completed', 90_000);

    getDatabase().prepare(
      `INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, created_at)
       VALUES (?, ?, ?, 'test', 'summary', NULL, ?)`,
    ).run(PROJECT_A, 'old-run', AGENT_ID, NOW);
    getDatabase().prepare(
      `INSERT INTO agent_turns (project_id, run_id, agent_id, turn_number, tool_name, started_at, completed_at)
       VALUES (?, ?, ?, 1, 'read', ?, ?)`,
    ).run(PROJECT_A, 'old-run', AGENT_ID, NOW - 10, NOW);
    getDatabase().prepare(
      `INSERT INTO agent_run_write_intents
       (project_id, run_id, phase_id, tool_name, tool_input, synthetic_output, stub_id, recorded_at)
       VALUES (?, ?, NULL, 'write', '{}', '{}', NULL, ?)`,
    ).run(PROJECT_A, 'old-run', NOW);
    getDatabase().prepare(
      `INSERT INTO digest_extract_revisions
       (project_id, agent_id, tier, content, metadata, run_id, parent_revision_id, created_at)
       VALUES (?, ?, 1, 'content', NULL, ?, NULL, ?)`,
    ).run(PROJECT_A, AGENT_ID, 'old-run', NOW);
    getDatabase().prepare(
      `INSERT INTO cortex_instructions
       (id, project_id, agent_id, content, input_hash, source_run_id, generated_at)
       VALUES ('ctx', ?, ?, 'content', 'hash', ?, ?)`,
    ).run(PROJECT_A, AGENT_ID, 'old-run', NOW);
    getDatabase().prepare(
      `INSERT INTO canopy_maps
       (project_id, machine_id, content, inputs_hash, generated_at, generated_by_run_id, token_estimate)
       VALUES (?, 'local', 'map', 'hash', ?, ?, 10)`,
    ).run(PROJECT_A, NOW, 'old-run');

    expect(pruneOldAgentRuns(86_400, projectScope(PROJECT_A), NOW)).toBe(1);

    expect(count('agent_runs', 'id = ?', 'old-run')).toBe(0);
    expect(count('agent_reports', 'run_id = ?', 'old-run')).toBe(0);
    expect(count('agent_turns', 'run_id = ?', 'old-run')).toBe(0);
    expect(count('agent_run_write_intents', 'run_id = ?', 'old-run')).toBe(0);
    expect(count('digest_extract_revisions', 'run_id IS NULL')).toBe(1);
    expect(count('cortex_instructions', 'source_run_id IS NULL')).toBe(1);
    expect(count('canopy_maps', 'generated_by_run_id IS NULL')).toBe(1);
  });
});
