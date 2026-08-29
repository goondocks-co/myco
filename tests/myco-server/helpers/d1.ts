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

/**
 * Applies every migration file in order and seeds the fixture rows every suite
 * shares: two projects, and the members those suites issue credentials to. A
 * credential carries a foreign key to `members`, so it cannot land without one —
 * enrollment is the only path that creates members in production, and a rig that
 * skips this seeds nothing a credential can attach to.
 */
export function migrateAndSeed(sqlite: Database): Database {
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0),('proj_2','b',0)`).run();
  const members = [...Array(10).keys()].map((i) => `('mem_machine_${i}','machine_${i}',0,NULL)`).join(',');
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ${members},('mem_anon',NULL,0,NULL),('mem_m','m',0,NULL)`).run();
  // The owner-route suites sign in as GitHub account 583231; it is a linked member.
  sqlite.query(`UPDATE members SET github_id = '583231' WHERE id = 'mem_machine_1'`).run();
  return sqlite;
}

/** A fresh in-memory database, migrated and seeded. */
export function seededSqlite(): Database {
  return migrateAndSeed(new Database(':memory:'));
}

/**
 * Seeds a credential the way the join route would, filling the lineage columns a
 * root credential carries. Tests that need a credential use this rather than
 * spelling the column list out, so a schema change lands in one place.
 */
export function seedCredential(
  sqlite: Database,
  over: { id?: string; memberId?: string; machineId?: string | null; hash?: string; expiresAt?: number; revokedAt?: number | null; bytesWritten?: number; issuedAt?: number } = {},
): string {
  const id = over.id ?? 'mt_1';
  const machineId = over.machineId === undefined ? 'machine_1' : over.machineId;
  const memberId = over.memberId ?? (machineId === null ? 'mem_anon' : `mem_${machineId}`);
  const issuedAt = over.issuedAt ?? 0;
  sqlite.query(`INSERT OR IGNORE INTO members (id,label,created_at,revoked_at) VALUES (?,?,?,NULL)`).run(memberId, memberId, issuedAt);
  sqlite.query(`INSERT INTO member_credentials
      (id,member_id,machine_id,token_hash,issued_at,expires_at,revoked_at,bytes_written,lineage_root,lineage_started_at,predecessor_id,first_used_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`)
    .run(id, memberId, machineId, over.hash ?? `h_${id}`, issuedAt, over.expiresAt ?? 9, over.revokedAt ?? null, over.bytesWritten ?? 0, id, issuedAt);
  return id;
}
