/**
 * End-to-end integration test for the canopy-describe map phase.
 *
 * Exercises the full chain:
 *   loaded canopy-describe.yaml -> executeMapPhase -> real canopy_describe_next /
 *   canopy_describe_write tools -> in-memory SQLite vault -> stub runtime.
 *
 * Uses bun:test + bun:sqlite to match the canopy-tools.test.ts conventions
 * (the DB-touching tests in this package use bun:test, not vitest).
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { loadAgentTasks, resolveDefinitionsDir } from '@myco/agent/loader.js';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { createVaultTools } from '@myco/agent/tools.js';
import type { PhaseDefinition } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CREATE_CANOPY_ENTRIES = `
  CREATE TABLE canopy_entries (
    project_id TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT,
    exports_json TEXT,
    imports_json TEXT,
    top_comment TEXT,
    llm_description TEXT,
    llm_updated_at INTEGER,
    mechanical_updated_at INTEGER NOT NULL,
    embedded INTEGER DEFAULT 0,
    PRIMARY KEY (project_id, path)
  )
`;

function seedSchema(db: Database) {
  db.run(CREATE_CANOPY_ENTRIES);
}

function loadCanopyDescribePhase(): PhaseDefinition {
  const tasks = loadAgentTasks(resolveDefinitionsDir());
  const task = tasks.find((t) => t.name === 'canopy-describe');
  if (!task?.phases?.[0]) throw new Error('canopy-describe yaml not loaded or has no phases');
  return task.phases[0] as PhaseDefinition;
}

/**
 * Minimal stub runtime that finds canopy_describe_write in the tool surface
 * and calls it with a canned description, then returns.
 */
function makeStubRuntime(description: string) {
  return {
    id: 'claude-sdk' as const,
    supports: () => false,
    execute: async (input: any) => {
      const sink = (input.toolSurface as any).tools?.find(
        (t: any) => t.name === 'canopy_describe_write',
      );
      if (sink) {
        await sink.handler({ description });
      }
      return { finalText: '', turnsUsed: 1, usage: { totalTokens: 100, requests: 1 } };
    },
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canopy-describe end-to-end (map phase)', () => {
  const projectRoot = '/tmp/myco-itest';
  const vaultDir = `${projectRoot}/.myco`;

  beforeEach(() => {
    closeDatabase();
    const db = initDatabase(':memory:');
    seedSchema(db);
  });

  it('batch mode: drains up to batch_size pending rows, leaves described rows untouched', async () => {
    closeDatabase();
    const db = initDatabase(':memory:');
    seedSchema(db);

    // 5 pending (no llm_description)
    for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) {
      db.prepare(
        'INSERT INTO canopy_entries (project_id, path, mechanical_updated_at) VALUES (?, ?, ?)',
      ).run(projectRoot, p, 100);
    }
    // 2 already-described
    db.prepare(
      'INSERT INTO canopy_entries (project_id, path, llm_description, llm_updated_at, mechanical_updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectRoot, 'x.ts', 'existing desc', 200, 100);
    db.prepare(
      'INSERT INTO canopy_entries (project_id, path, llm_description, llm_updated_at, mechanical_updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectRoot, 'y.ts', 'existing desc', 200, 100);

    const phase = loadCanopyDescribePhase();
    const allTools = createVaultTools('myco-agent', 'run-1', { projectRoot, vaultDir, dryRun: false });

    const result = await executeMapPhase({
      phase,
      allTools,
      runtime: makeStubRuntime('A short one-sentence description.'),
      // batch_size: 3 overrides the yaml default of 10
      params: { batch_size: 3 },
      systemPrompt: 'sys',
      runId: 'run-1',
      agentId: 'myco-agent',
    });

    expect(result.written).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);

    const described = db
      .prepare('SELECT COUNT(*) AS n FROM canopy_entries WHERE llm_description IS NOT NULL')
      .get() as { n: number };
    // 3 newly described + 2 pre-existing = 5
    expect(described.n).toBe(5);

    const pending = db
      .prepare(
        'SELECT COUNT(*) AS n FROM canopy_entries WHERE llm_updated_at IS NULL OR llm_updated_at < mechanical_updated_at',
      )
      .get() as { n: number };
    // 5 pending - 3 batch_size = 2 still undescribed
    expect(pending.n).toBe(2);
  });

  it('single-row mode: re-describes a specific row regardless of pending state', async () => {
    closeDatabase();
    const db = initDatabase(':memory:');
    seedSchema(db);

    // Already-described row - would not match the pending predicate in batch mode
    db.prepare(
      'INSERT INTO canopy_entries (project_id, path, llm_description, llm_updated_at, mechanical_updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(projectRoot, 'src/foo.ts', 'old description', 200, 100);

    const phase = loadCanopyDescribePhase();
    const allTools = createVaultTools('myco-agent', 'run-2', { projectRoot, vaultDir, dryRun: false });

    const result = await executeMapPhase({
      phase,
      allTools,
      runtime: makeStubRuntime('A new description.'),
      // single-row mode: canopy_entry_path bypasses the pending predicate
      params: { canopy_entry_path: 'src/foo.ts' },
      systemPrompt: 'sys',
      runId: 'run-2',
      agentId: 'myco-agent',
    });

    expect(result.itemCount).toBe(1);
    expect(result.written).toBe(1);

    const row = db
      .prepare('SELECT llm_description FROM canopy_entries WHERE path = ?')
      .get('src/foo.ts') as { llm_description: string };
    expect(row.llm_description).toBe('A new description.');
  });
});
