import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

describe('canopy_maps migration v27', () => {
  it('creates canopy_maps table with composite PK on fresh install', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = db.prepare(`PRAGMA table_info(canopy_maps)`).all() as Array<{
      name: string; pk: number; notnull: number;
    }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'content', 'generated_at', 'generated_by_run_id',
      'inputs_hash', 'machine_id', 'project_id', 'token_estimate',
    ]);
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(['machine_id', 'project_id']);
  });

  it('adds canopy_map_tool_calls to sessions', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const c = cols.find((x) => x.name === 'canopy_map_tool_calls');
    expect(c).toBeDefined();
    expect(c?.dflt_value).toBe('0');
  });

  it('SCHEMA_VERSION is 41', () => {
    expect(SCHEMA_VERSION).toBe(41);
  });

  it('idempotent re-apply', () => {
    const db = new Database(':memory:');
    createSchema(db);
    createSchema(db);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canopy_maps'`).all();
    expect(tables).toHaveLength(1);
  });
});
