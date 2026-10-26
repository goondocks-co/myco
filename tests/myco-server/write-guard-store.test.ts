import { expect, it } from 'bun:test';
import { isSelectStatement } from '@myco-server-worker/core/sql-statements.js';
import { writeGuardStore } from '@myco-server-worker/core/write-guard-store.js';
import { sqliteEnv } from './helpers/fixtures.js';

it('common table SELECTs keep their read path while common table mutations require authority', async () => {
  const { db } = sqliteEnv();
  let assertions = 0;
  const guarded = writeGuardStore(db, () => {
    assertions++;
    return db.prepare(`SELECT json_extract('[]','$[write_refused]')`);
  }, () => { throw new Error('write refused'); });
  for (const sql of [
    'SELECT 1 AS n',
    '-- leading\nWITH a AS (SELECT 1 AS n) SELECT n FROM a',
    'WITH RECURSIVE a(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM a WHERE n<2) SELECT MAX(n) AS n FROM a',
    'WITH "quoted name"(n) AS NOT MATERIALIZED (SELECT 1), b AS MATERIALIZED (SELECT n FROM "quoted name") SELECT n FROM b',
    'WITH a AS (SELECT \'UPDATE )\' AS n /* ) */) SELECT n FROM a',
  ]) {
    expect(isSelectStatement(sql)).toBe(true);
    expect(await guarded.prepare(sql).first()).not.toBeNull();
    expect(assertions).toBe(0);
  }
  for (const sql of [
    "WITH a AS (SELECT 'SELECT' AS n) DELETE FROM projects WHERE project_id='proj_1'",
    "WITH a AS (SELECT 1) UPDATE projects SET name='changed' WHERE project_id='proj_1'",
    "WITH a AS (SELECT 1) INSERT INTO projects(project_id,name,created_at) VALUES('extra','x',1)",
  ]) {
    expect(isSelectStatement(sql)).toBe(false);
    await expect(guarded.prepare(sql).run()).rejects.toThrow('write refused');
  }
  expect(assertions).toBe(3);
  expect((await db.prepare("SELECT name FROM projects WHERE project_id='proj_1'").first<{ name: string }>())?.name).toBe('a');
});
