import { Database } from 'bun:sqlite';
import type { RelationalStore, PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';

/**
 * The shipped self-hosted relational store, with test observation hooks wrapped
 * around it. The store itself is never reimplemented here: a semantics fix in the
 * production adapter must reach the store the suite exercises, which it cannot do
 * if the suite carries its own copy.
 */
export function sqliteD1(
  sqlite: Database,
  options: { onFirst?: (sql: string, row: Record<string, unknown> | null) => Record<string, unknown> | null; onSql?: (sql: string) => void } = {},
): RelationalStore {
  const store = sqliteRelationalStore(sqlite);

  // The inner statement is spread, not replaced: `batch` reads fields the shipped
  // store puts on its own statements, and an observed statement must still carry them.
  const observe = (sql: string, statement: PreparedStatement): PreparedStatement => ({
    ...statement,
    bind: (...values: unknown[]) => observe(sql, statement.bind(...values)),
    run: async () => { options.onSql?.(sql); return statement.run(); },
    all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => { options.onSql?.(sql); return statement.all<T>(); },
    first: async <T,>() => {
      options.onSql?.(sql);
      const row = (await statement.first<Record<string, unknown>>()) ?? null;
      return (options.onFirst ? options.onFirst(sql, row) : row) as T | null;
    },
  });

  return {
    prepare: (sql: string) => observe(sql, store.prepare(sql)),
    batch: (statements: PreparedStatement[]) => {
      // Statements inside a batch are executed too, and the gates that inspect the
      // executed SQL must see them.
      for (const statement of statements) options.onSql?.((statement as unknown as { sql: string }).sql);
      return store.batch(statements);
    },
  };
}

/** A fresh in-memory database with every migration file applied in order, foreign keys enforced, and two projects. */
export function seededSqlite(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0),('proj_2','b',0)`).run();
  return sqlite;
}
