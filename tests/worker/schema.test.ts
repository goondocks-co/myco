import { describe, it, expect } from 'bun:test';
import { initD1Schema } from '@myco-team-worker/schema';

interface RecordedRun {
  sql: string;
  values: unknown[];
}

interface RecordedBatch {
  sqls: string[];
}

function createFakeD1(options: { markerPresent?: boolean } = {}) {
  const runs: RecordedRun[] = [];
  const batchedSql: string[] = [];
  const batches: RecordedBatch[] = [];
  const markerPresent = options.markerPresent ?? false;

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
            const marker = /SELECT value FROM team_config WHERE key = \?/.test(sql)
              && state.values[0] === 'semantic_graph_pruned';
            if (marker && markerPresent) {
              return { value: '1' } as T;
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
});
