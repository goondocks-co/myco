/**
 * The migrated database a server test gets is a copy of one migrated once per
 * process (`helpers/d1.ts` `seededSqlite`). A copy must be what a fresh
 * migration would have produced: the same schema and the same rows, with a
 * Deployment id of its own. A migration that draws another value at random,
 * or a setting the copy loses, fails here, before every copy shares it and a
 * test that needs two databases to differ passes against one.
 *
 * The reference a copy is compared with comes from the same `migrateAndSeed`,
 * so a step that helper skipped would be missing from both. The copy is also
 * held to the migration files as committed: their count is the schema version
 * it must carry, and applying them straight from disk must produce its schema.
 * The rows of SQLite's own `sqlite_*` tables, `sqlite_stat1` among them, are
 * deliberately not compared: they are the engine's bookkeeping, not data a
 * migration writes.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOYMENT_ID_KEY, migrateAndSeed, seededSqlite } from './helpers/d1.js';

function contents(sqlite: Database): { schema: unknown[]; rows: Record<string, unknown[]> } {
  const schema = sqlite.query(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
  const tables = (sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((t) => t.name);
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    try {
      rows[table] = sqlite.query(`SELECT * FROM "${table}"`).all();
    } catch {
      // A virtual table whose module this connection has not loaded holds no rows a migration wrote.
    }
  }
  return { schema, rows };
}

const withoutDeploymentId = (rows: Record<string, unknown[]>) => ({
  ...rows,
  schema_meta: (rows.schema_meta as Array<{ key: string }>).filter((row) => row.key !== DEPLOYMENT_ID_KEY),
});
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'myco-server', 'migrations');
const schemaOf = (sqlite: Database) => sqlite.query(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`).all();
const deploymentId = (sqlite: Database) => (sqlite.query('SELECT value FROM schema_meta WHERE key = ?').get(DEPLOYMENT_ID_KEY) as { value: string }).value;

describe('a seeded database copy', () => {
  it('holds what a fresh migration holds, with a Deployment id of its own and foreign keys enforced', () => {
    const fresh = migrateAndSeed(new Database(':memory:'));
    const [first, second] = [seededSqlite(), seededSqlite()];
    try {
      const want = contents(fresh);
      for (const copy of [first, second]) {
        const got = contents(copy);
        expect(got.schema).toEqual(want.schema);
        expect(withoutDeploymentId(got.rows)).toEqual(withoutDeploymentId(want.rows));
        expect(copy.query('PRAGMA user_version').get()).toEqual(fresh.query('PRAGMA user_version').get());
        expect(copy.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      }
      expect(new Set([deploymentId(fresh), deploymentId(first), deploymentId(second)]).size).toBe(3);
      // Copies are independent: a write to one is not in the other.
      first.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_copy', 'c', 0)`);
      expect(second.query(`SELECT COUNT(*) AS n FROM projects WHERE project_id = 'proj_copy'`).get()).toEqual({ n: 0 });
    } finally {
      for (const db of [fresh, first, second]) db.close();
    }
  });

  it('carries every committed migration file: their count as its schema version, and the schema they build from disk', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((name) => /^\d{4}_v\d+\.sql$/.test(name)).sort();
    expect(files.length).toBeGreaterThan(0);
    // The files are numbered from 1 with no gap, so the count is the version the last one stamps.
    expect(files.map((name) => Number(name.slice(0, 4)))).toEqual(files.map((_, index) => index + 1));
    const fromDisk = new Database(':memory:');
    const copy = seededSqlite();
    try {
      fromDisk.exec('PRAGMA foreign_keys = ON');
      for (const name of files) fromDisk.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
      const version = (sqlite: Database) => (sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get() as { value: string }).value;
      expect(version(fromDisk)).toBe(String(files.length));
      expect(version(copy)).toBe(String(files.length));
      expect(schemaOf(copy)).toEqual(schemaOf(fromDisk));
    } finally {
      fromDisk.close();
      copy.close();
    }
  });
});
