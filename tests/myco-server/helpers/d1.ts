import { Database } from 'bun:sqlite';
import type { D1Like, D1StatementLike, D1RunResult } from '@myco-server-worker/env.js';
import { renderSchemaSql } from '@myco-server-worker/db/migrate.js';

interface Captured extends D1StatementLike {
  sql: string;
  params: unknown[];
}

const isRead = (sql: string) => /^\s*SELECT\b/i.test(sql);

/** A `D1Like` over an in-memory bun:sqlite database: `batch` runs in one transaction, every write result carries the real row-change count, and every read result carries its rows. */
export function sqliteD1(sqlite: Database, options: { onFirst?: (sql: string, row: Record<string, unknown> | null) => Record<string, unknown> | null } = {}): D1Like {
  const execute = (sql: string, params: unknown[]): D1RunResult =>
    isRead(sql)
      ? { results: sqlite.query(sql).all(...(params as any[])) as unknown[], meta: { changes: 0 } }
      : { results: [], meta: { changes: sqlite.query(sql).run(...(params as any[])).changes } };
  const statement = (sql: string, params: unknown[]): Captured => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => execute(sql, params),
    first: async <T,>() => {
      const row = (sqlite.query(sql).get(...(params as any[])) as Record<string, unknown> | null) ?? null;
      return (options.onFirst ? options.onFirst(sql, row) : row) as T | null;
    },
  });
  const runBatch = sqlite.transaction((stmts: Captured[]): D1RunResult[] => stmts.map((s) => execute(s.sql, s.params)));
  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (stmts: D1StatementLike[]) => runBatch(stmts as Captured[]),
  };
}

/** A fresh in-memory database with the rendered schema and two projects. */
export function seededSqlite(): Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(renderSchemaSql());
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0),('proj_2','b',0)`).run();
  return sqlite;
}
