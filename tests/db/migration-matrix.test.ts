import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

/**
 * Migration-matrix guard: every historical fresh-vault shape must upgrade
 * through the current migration chain to SCHEMA_VERSION and come out
 * structurally identical to a fresh-created vault.
 *
 * Fixtures under tests/db/fixtures/historical/ are authentic schema dumps of
 * vaults fresh-created by the era code at each historical SCHEMA_VERSION
 * (see generate.ts there). This pins two invariants:
 *   1. No migration references DDL that does not exist yet at its point in
 *      the chain (the class that bricked v34–v40 vaults at migrateV40ToV41).
 *   2. Migrated vaults and fresh vaults converge on one schema shape.
 */

const FIXTURES_DIR = path.join(import.meta.dir, 'fixtures', 'historical');

interface Fixture {
  version: number;
  commit: string;
  statements: string[];
}

interface TableShape {
  columns: Set<string>;
  foreignKeys: Set<string>;
  withoutRowid: boolean;
}

interface SchemaShape {
  tables: Map<string, TableShape>;
  virtualTables: Map<string, string>;
  indexes: Map<string, string>;
  triggers: Map<string, string>;
}

/** Collapse whitespace and strip identifier quotes so era RENAME-rebuild
 * artifacts ("activities") compare equal to fresh DDL (activities). */
function normalizeSql(sql: string): string {
  return sql.replace(/"/g, '').replace(/\s+/g, ' ').trim();
}

function isFtsShadow(name: string, ftsNames: ReadonlySet<string>): boolean {
  const m = name.match(/^(.*)_(data|idx|content|docsize|config)$/);
  return m !== null && ftsNames.has(m[1]);
}

function collectShape(db: Database): SchemaShape {
  const master = db.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ type: string; name: string; sql: string | null }>;

  const virtualTables = new Map<string, string>();
  for (const row of master) {
    if (row.type === 'table' && row.sql && /CREATE VIRTUAL TABLE/i.test(row.sql)) {
      virtualTables.set(row.name, normalizeSql(row.sql));
    }
  }
  const ftsNames = new Set(virtualTables.keys());

  const shape: SchemaShape = {
    tables: new Map(),
    virtualTables,
    indexes: new Map(),
    triggers: new Map(),
  };

  for (const row of master) {
    if (row.type === 'table' && row.sql && !virtualTables.has(row.name) && !isFtsShadow(row.name, ftsNames)) {
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${row.name})`).all() as Array<{
          name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
        }>).map((c) => `${c.name}|${c.type}|notnull=${c.notnull}|dflt=${c.dflt_value ?? ''}|pk=${c.pk}`),
      );
      const foreignKeys = new Set(
        (db.prepare(`PRAGMA foreign_key_list(${row.name})`).all() as Array<{
          table: string; from: string; to: string | null; on_delete: string;
        }>).map((fk) => `${fk.from}->${fk.table}(${fk.to ?? ''})|on_delete=${fk.on_delete}`),
      );
      shape.tables.set(row.name, {
        columns,
        foreignKeys,
        withoutRowid: /WITHOUT ROWID/i.test(row.sql),
      });
    } else if (row.type === 'index' && row.sql) {
      shape.indexes.set(row.name, normalizeSql(row.sql));
    } else if (row.type === 'trigger' && row.sql) {
      shape.triggers.set(row.name, normalizeSql(row.sql));
    }
  }
  return shape;
}

function diffShapes(migrated: SchemaShape, fresh: SchemaShape): string[] {
  const problems: string[] = [];

  const diffKeySets = (kind: string, a: Map<string, unknown>, b: Map<string, unknown>) => {
    for (const name of a.keys()) if (!b.has(name)) problems.push(`${kind} ${name}: only in migrated`);
    for (const name of b.keys()) if (!a.has(name)) problems.push(`${kind} ${name}: only in fresh`);
  };

  diffKeySets('table', migrated.tables, fresh.tables);
  for (const [name, m] of migrated.tables) {
    const f = fresh.tables.get(name);
    if (!f) continue;
    for (const col of m.columns) if (!f.columns.has(col)) problems.push(`table ${name}: column only in migrated: ${col}`);
    for (const col of f.columns) if (!m.columns.has(col)) problems.push(`table ${name}: column only in fresh: ${col}`);
    for (const fk of m.foreignKeys) if (!f.foreignKeys.has(fk)) problems.push(`table ${name}: FK only in migrated: ${fk}`);
    for (const fk of f.foreignKeys) if (!m.foreignKeys.has(fk)) problems.push(`table ${name}: FK only in fresh: ${fk}`);
    if (m.withoutRowid !== f.withoutRowid) problems.push(`table ${name}: WITHOUT ROWID mismatch`);
  }

  const diffSqlMaps = (kind: string, a: Map<string, string>, b: Map<string, string>) => {
    diffKeySets(kind, a, b);
    for (const [name, sql] of a) {
      const other = b.get(name);
      if (other !== undefined && other !== sql) {
        problems.push(`${kind} ${name}: SQL differs\n  migrated: ${sql}\n  fresh:    ${other}`);
      }
    }
  };
  diffSqlMaps('virtual table', migrated.virtualTables, fresh.virtualTables);
  diffSqlMaps('index', migrated.indexes, fresh.indexes);
  diffSqlMaps('trigger', migrated.triggers, fresh.triggers);

  return problems;
}

function loadFixture(file: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Fixture;
}

function buildEraVault(fixture: Fixture): Database {
  const db = new Database(':memory:');
  for (const stmt of fixture.statements) db.exec(stmt);
  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (?, 0)`).run(fixture.version);
  return db;
}

describe('migration matrix: historical fresh vaults upgrade and converge', () => {
  const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => /^v\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));

  it('has fixtures to test', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  const freshDb = new Database(':memory:');
  createSchema(freshDb);
  const freshShape = collectShape(freshDb);

  for (const file of fixtureFiles) {
    it(`vault fresh-created at ${file.replace('.json', '')} reaches v${SCHEMA_VERSION} and matches fresh`, () => {
      const fixture = loadFixture(file);
      const db = buildEraVault(fixture);

      createSchema(db);

      const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
      expect(stamped).toBe(SCHEMA_VERSION);

      const problems = diffShapes(collectShape(db), freshShape);
      expect(problems, problems.join('\n')).toEqual([]);
      db.close();
    });
  }
});
