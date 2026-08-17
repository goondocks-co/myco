import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderSchemaSql } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';

describe('deploy-time schema', () => {
  it('renders every statement as executable SQL', () => {
    const sql = renderSchemaSql();
    expect(sql.split(';').filter((s) => s.trim()).length).toBeGreaterThanOrEqual(SCHEMA_DDL.length);
    const sqlite = new Database(':memory:');
    sqlite.exec(sql);
    const names = sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
    expect(names.map((r) => r.name)).toEqual(
      expect.arrayContaining(['events', 'member_tokens', 'projects', 'schema_meta', 'sessions']),
    );
  });

  it('is re-runnable', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(renderSchemaSql());
    sqlite.exec(renderSchemaSql());
    expect((sqlite.query('SELECT COUNT(*) c FROM schema_meta').get() as any).c).toBe(1);
  });
});
