import { Database } from 'bun:sqlite';
import type { RelationalStore, PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';

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
/**
 * Migrates and seeds a database. `beforeStep42` seeds rows as a Deployment held them before schema step 42, the step
 * that fences blob rows to a generation: it runs at step 41, and the remaining steps then apply over those rows as a
 * migration does.
 */
export function migrateAndSeed(sqlite: Database, options: { beforeStep42?: (sqlite: Database) => void } = {}): Database {
  sqlite.exec('PRAGMA foreign_keys = ON');
  const files = renderMigrationFiles();
  const step42 = files.findIndex((file) => file.name === '0042_v42.sql');
  for (const file of files.slice(0, step42)) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0),('proj_2','b',0)`).run();
  const members = [...Array(10).keys()].map((i) => `('mem_machine_${i}','machine_${i}',0,NULL)`).join(',');
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ${members},('mem_anon',NULL,0,NULL),('mem_m','m',0,NULL)`).run();
  // The owner-route suites sign in as GitHub account 583231; it is a linked member.
  sqlite.query(`UPDATE members SET github_id = '583231' WHERE id = 'mem_machine_1'`).run();
  options.beforeStep42?.(sqlite);
  for (const file of files.slice(step42)) sqlite.exec(file.sql);
  return sqlite;
}

/** A fresh in-memory database, migrated and seeded. */
export function seededSqlite(options: { beforeStep42?: (sqlite: Database) => void } = {}): Database {
  return migrateAndSeed(new Database(':memory:'), options);
}

/** A blob row as this build's upload registers one. */
export interface RegisteredBlob { projectId: string; key: string; size: number; mediaType?: string; tokenId?: string; receivedAt?: number; generation?: string }

/**
 * Registers a blob row under a generation of its own, as an upload does, unless a row already registers the content.
 * Answers the stored object the registered row names, where a fixture places the bytes.
 */
export function registerBlob(sqlite: Database, row: RegisteredBlob): string {
  sqlite.query(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT (project_id, key) DO NOTHING`)
    .run(row.projectId, row.key, row.size, row.mediaType ?? 'text/plain', row.tokenId ?? 't', row.receivedAt ?? 1, row.generation ?? crypto.randomUUID());
  const held = sqlite.query(`SELECT ${registeredObjectKeySql('?', '?')} AS object_key`).get(row.projectId, row.key) as { object_key: string };
  return held.object_key;
}

/** Inserts a blob row with no generation, as a Deployment before schema step 42 registered one. Only valid inside `beforeStep42`. */
export function legacyBlob(sqlite: Database, row: Omit<RegisteredBlob, 'generation'>): string {
  sqlite.query(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(row.projectId, row.key, row.size, row.mediaType ?? 'text/plain', row.tokenId ?? 't', row.receivedAt ?? 1);
  return `${row.projectId}/${row.key}`;
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
