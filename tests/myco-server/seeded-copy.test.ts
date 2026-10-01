/**
 * The migrated database a server test gets is a copy of one migrated once per
 * process (`helpers/d1.ts` `seededSqlite`). A copy must be what a fresh
 * migration would have produced: the same schema and the same rows, with a
 * Deployment id of its own. A migration that draws another value at random,
 * or a setting the copy loses, fails here, before every copy shares it and a
 * test that needs two databases to differ passes against one.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
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
});
