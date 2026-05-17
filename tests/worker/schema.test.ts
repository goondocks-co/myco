import { describe, it, expect } from 'bun:test';
import { initD1Schema } from '@myco-team-worker/schema';

interface RecordedRun {
  sql: string;
  values: unknown[];
}

interface RecordedBatch {
  sqls: string[];
}

function createFakeD1(options: { markerPresent?: boolean; projectIdMarkerPresent?: boolean; unsafeNodeCount?: number } = {}) {
  const runs: RecordedRun[] = [];
  const batchedSql: string[] = [];
  const batches: RecordedBatch[] = [];
  const markerPresent = options.markerPresent ?? false;
  const projectIdMarkerPresent = options.projectIdMarkerPresent ?? false;
  const unsafeNodeCount = options.unsafeNodeCount ?? 0;

  return {
    runs,
    batchedSql,
    batches,
    db: {
      prepare(sql: string) {
        const state = { values: [] as unknown[] };
        return {
          sql,
          bind(...values: unknown[]) {
            state.values = values;
            return this;
          },
          async run() {
            runs.push({ sql, values: [...state.values] });
            return { success: true };
          },
          async first<T = unknown>(): Promise<T | null> {
            const semGraphMarker = /SELECT value FROM team_config WHERE key = \?/.test(sql)
              && state.values[0] === 'semantic_graph_pruned';
            if (semGraphMarker && markerPresent) {
              return { value: '1' } as T;
            }
            const projectIdMarker = /SELECT value FROM team_config WHERE key = \?/.test(sql)
              && state.values[0] === 'project_id_orphans_pruned_v36';
            if (projectIdMarker && projectIdMarkerPresent) {
              return { value: '1' } as T;
            }
            // Active-node query for the v36 prune gate. The schema
            // helper sums rows where last_seen >= cutoff and
            // sync_protocol_version < minClientVersion. We answer
            // with the test-supplied `unsafeNodeCount`.
            if (/SELECT COUNT\(\*\) AS unsafe\s+FROM nodes/.test(sql)) {
              return { unsafe: unsafeNodeCount } as T;
            }
            return null;
          },
        };
      },
      async batch(statements: Array<{ sql: string }>) {
        batchedSql.push(...statements.map((statement) => statement.sql));
        batches.push({ sqls: statements.map((s) => s.sql) });
        return [];
      },
    },
  };
}

describe('initD1Schema', () => {
  it('adds approved_at and backfills approved/generated skill candidates', async () => {
    const fake = createFakeD1();

    await initD1Schema(fake.db as never);

    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE plans ADD COLUMN logical_key TEXT',
      values: [],
    });

    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_candidates ADD COLUMN approved_at INTEGER',
      values: [],
    });

    expect(fake.runs).toContainEqual({
      sql:
        `UPDATE skill_candidates
       SET approved_at = strftime('%s', 'now')
     WHERE approved_at IS NULL
       AND status IN (?, ?)`,
      values: ['approved', 'generated'],
    });
  });

  it('mirrors skill candidate quality columns in fresh DDL and migrations', async () => {
    const fake = createFakeD1();

    await initD1Schema(fake.db as never);

    const skillCandidatesDdl = fake.batchedSql.find((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS skill_candidates'),
    );

    expect(skillCandidatesDdl).toMatch(/\bevidence_bundle_id\s+TEXT\b/);
    expect(skillCandidatesDdl).toMatch(/\bquality_score\s+REAL\b/);
    expect(skillCandidatesDdl).toMatch(/\bquality_failures\s+TEXT NOT NULL DEFAULT '\[\]'/);
    expect(skillCandidatesDdl).toMatch(/\bcoverage_matches\s+TEXT NOT NULL DEFAULT '\[\]'/);
    expect(skillCandidatesDdl).toMatch(/\blast_reconciled_at\s+INTEGER\b/);
    expect(skillCandidatesDdl).toMatch(/\breconciliation_reason\s+TEXT\b/);

    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_candidates ADD COLUMN evidence_bundle_id TEXT',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_candidates ADD COLUMN quality_score REAL',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: "ALTER TABLE skill_candidates ADD COLUMN quality_failures TEXT NOT NULL DEFAULT '[]'",
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: "ALTER TABLE skill_candidates ADD COLUMN coverage_matches TEXT NOT NULL DEFAULT '[]'",
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_candidates ADD COLUMN last_reconciled_at INTEGER',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_candidates ADD COLUMN reconciliation_reason TEXT',
      values: [],
    });
  });

  describe('semantic graph one-shot prune', () => {
    it('runs the prune batch when the marker is absent', async () => {
      const fake = createFakeD1({ markerPresent: false });

      await initD1Schema(fake.db as never);

      const pruneBatch = fake.batches.find((b) =>
        b.sqls.some((s) => s.includes("DELETE FROM graph_edges WHERE type IN")),
      );
      expect(pruneBatch, 'expected a prune batch when marker is absent').toBeDefined();
      expect(pruneBatch!.sqls).toContainEqual(
        expect.stringContaining("REFERENCES', 'AFFECTS', 'DEPENDS_ON', 'RELATES_TO"),
      );
      expect(pruneBatch!.sqls).toContainEqual(
        expect.stringContaining('DELETE FROM entities'),
      );
      expect(pruneBatch!.sqls).toContainEqual(
        expect.stringContaining('INSERT INTO team_config (key, value)'),
      );
    });

    it('skips the prune batch when the marker is already present', async () => {
      const fake = createFakeD1({ markerPresent: true });

      await initD1Schema(fake.db as never);

      const pruneBatch = fake.batches.find((b) =>
        b.sqls.some((s) => s.includes("DELETE FROM graph_edges WHERE type IN")),
      );
      expect(pruneBatch, 'prune batch should not run when marker is already set').toBeUndefined();
    });
  });

  it('defers parent_prompt_batch index creation until after prompt_batches migrations', async () => {
    const fake = createFakeD1();

    await initD1Schema(fake.db as never);

    expect(fake.batchedSql).not.toContain(
      'CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)',
    );

    const migrationIndex = fake.runs.findIndex(
      (run) => run.sql === 'ALTER TABLE prompt_batches ADD COLUMN parent_prompt_batch_id INTEGER',
    );
    const postMigrationIndex = fake.runs.findIndex(
      (run) => run.sql === 'CREATE INDEX IF NOT EXISTS idx_prompt_batches_parent ON prompt_batches (parent_prompt_batch_id)',
    );

    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(postMigrationIndex).toBeGreaterThan(migrationIndex);
  });

  it('adds project_id columns and indexes for Grove-scoped sync rows', async () => {
    const fake = createFakeD1();

    await initD1Schema(fake.db as never);

    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE sessions ADD COLUMN project_id TEXT',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'ALTER TABLE skill_records ADD COLUMN project_id TEXT',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions (project_id)',
      values: [],
    });
    expect(fake.runs).toContainEqual({
      sql: 'CREATE INDEX IF NOT EXISTS idx_skill_records_project_id ON skill_records (project_id)',
      values: [],
    });
  });

  it('creates the derived release-state sync table and indexes', async () => {
    const fake = createFakeD1();

    await initD1Schema(fake.db as never);

    expect(fake.batchedSql).toContainEqual(expect.stringContaining('CREATE TABLE IF NOT EXISTS knowledge_release_state'));
    expect(fake.batchedSql).toContainEqual(
      'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_record ON knowledge_release_state (namespace, record_id, machine_id)',
    );
    expect(fake.runs).toContainEqual({
      sql: 'CREATE INDEX IF NOT EXISTS idx_knowledge_release_state_project_id ON knowledge_release_state (project_id)',
      values: [],
    });
  });
});

describe('initD1Schema v36 project_id orphan-row prune (cross-machine compat gate)', () => {
  it('runs the prune when no minClientVersion is supplied (legacy callers)', async () => {
    const fake = createFakeD1();

    // Calling with no options preserves historical behavior — the
    // prune runs unconditionally. This is what existing long-deployed
    // workers do today; we must not regress them.
    await initD1Schema(fake.db as never);

    const pruneRan = fake.runs.some(
      (run) => run.sql.includes('DELETE FROM sessions') && run.sql.includes('project_id IS NULL'),
    );
    expect(pruneRan).toBe(true);
    expect(fake.runs).toContainEqual({
      sql: 'INSERT INTO team_config (key, value) VALUES (?, ?)',
      values: ['project_id_orphans_pruned_v36', '1'],
    });
  });

  it('runs the prune when minClientVersion is supplied and every active node meets the floor', async () => {
    const fake = createFakeD1({ unsafeNodeCount: 0 });

    await initD1Schema(fake.db as never, { minClientVersion: 1 });

    const pruneRan = fake.runs.some(
      (run) => run.sql.includes('DELETE FROM sessions') && run.sql.includes('project_id IS NULL'),
    );
    expect(pruneRan).toBe(true);
    expect(fake.runs).toContainEqual({
      sql: 'INSERT INTO team_config (key, value) VALUES (?, ?)',
      values: ['project_id_orphans_pruned_v36', '1'],
    });
  });

  it('defers the prune when an active node is below the minClientVersion floor', async () => {
    const fake = createFakeD1({ unsafeNodeCount: 1 });

    // A single teammate on a pre-window protocol blocks the destructive
    // prune so we don't silently delete that teammate's pre-Grove rows
    // on first boot of the upgraded worker. The marker is NOT written,
    // so the worker re-evaluates on its next boot — the prune lands
    // automatically once the teammate ships the upgrade.
    await initD1Schema(fake.db as never, { minClientVersion: 2 });

    const pruneRan = fake.runs.some(
      (run) => run.sql.includes('DELETE FROM sessions') && run.sql.includes('project_id IS NULL'),
    );
    expect(pruneRan).toBe(false);

    const markerWritten = fake.runs.some(
      (run) => run.sql === 'INSERT INTO team_config (key, value) VALUES (?, ?)'
        && run.values[0] === 'project_id_orphans_pruned_v36',
    );
    expect(markerWritten).toBe(false);
  });

  it('skips the gate query and prune entirely when the marker is already present', async () => {
    const fake = createFakeD1({ projectIdMarkerPresent: true, unsafeNodeCount: 99 });

    await initD1Schema(fake.db as never, { minClientVersion: 2 });

    const pruneRan = fake.runs.some(
      (run) => run.sql.includes('DELETE FROM sessions') && run.sql.includes('project_id IS NULL'),
    );
    expect(pruneRan).toBe(false);
  });
});
