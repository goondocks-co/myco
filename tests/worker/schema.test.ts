import { describe, it, expect } from 'vitest';
import { initD1Schema } from '../../src/worker/src/schema';

interface RecordedRun {
  sql: string;
  values: unknown[];
}

function createFakeD1() {
  const runs: RecordedRun[] = [];
  const batchedSql: string[] = [];

  return {
    runs,
    batchedSql,
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
        };
      },
      async batch(statements: Array<{ sql: string }>) {
        batchedSql.push(...statements.map((statement) => statement.sql));
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
});
