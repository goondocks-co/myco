/**
 * R2/R5 per-direction coverage gates (Residency spec rev 4 §6, restated by the
 * 1.3.0 completion plan after the entity_mentions finding).
 *
 * The original union-form gate (`RESIDENCY_TABLE_ORDER ∪ backup ⊇ scoped`) was
 * proven blind: a table only ONE direction can carry passes the union while the
 * single-carrier direction silently loses it. And a pure set-membership gate is
 * blind one level down — the pre-v75 defect was never membership, it was
 * CAPABILITY (`entity_mentions` was "covered" by the attach sidecar while no
 * dump could address its keyless rows). So the detach-direction gate here is
 * BEHAVIORAL: seed one row into every project-scoped table, take a
 * project-scoped backup — the detach artifact's exact mechanism — restore it
 * into a fresh vault, and assert every table's row survived, by name. A table
 * the carrier genuinely cannot carry fails here at build time instead of
 * surfacing as silent data loss in a detach.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { BACKUP_TABLES, createBackup, restoreBackup, projectScope } from '@myco/backup/engine.js';
import { RESIDENCY_TABLE_ORDER } from '@myco/db/queries/residency-apply.js';
import { createSchema } from '@myco/db/schema.js';

const PROJ = 'proj_cccccccccccccccccccccccccccccccc';

/** A minimally-valid row for `table`: every NOT-NULL-without-DEFAULT column
 *  gets a type-shaped value, `project_id` gets the scoped project, and the
 *  primary key gets a stable per-table id. Values only need to survive the
 *  dump→restore round trip — they carry no semantic weight. */
function seedRow(db: Database, table: string): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }>;
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const col of info) {
    if (col.name === 'project_id') { cols.push(col.name); vals.push(PROJ); continue; }
    if (col.pk > 0) {
      cols.push(col.name);
      vals.push(col.type.toUpperCase().includes('INT') ? 1 : `${table}_row_1`);
      continue;
    }
    if (col.notnull === 1 && col.dflt_value == null) {
      cols.push(col.name);
      const t = col.type.toUpperCase();
      vals.push(t.includes('INT') ? 1 : t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') ? 1.0 : `${table}_${col.name}`);
    }
  }
  db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...(vals as never[]));
}

describe('residency per-direction coverage (R2/R5)', () => {
  test('DETACH (behavioral): a project-scoped backup restores EVERY project-scoped table, one row each, by name', () => {
    const source = new Database(':memory:');
    createSchema(source, 'local');
    // FKs off for seeding: values are synthetic and the dump/restore path
    // under test runs FK-off itself, so referential order is irrelevant here.
    source.exec('PRAGMA foreign_keys = OFF');
    for (const table of GROVE_PROJECT_SCOPED_TABLES) seedRow(source, table);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-coverage-'));
    try {
      const dump = createBackup(source, dir, 'machine_test', projectScope(PROJ), 'coverage');

      const target = new Database(':memory:');
      createSchema(target, 'local');
      restoreBackup(target, dump);

      const missing: string[] = [];
      for (const table of GROVE_PROJECT_SCOPED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) missing.push(`${table} (restored ${c} of 1)`);
      }
      expect(missing).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ATTACH: push ∪ backup covers every project-scoped table', () => {
    const carriers = new Set<string>([...RESIDENCY_TABLE_ORDER, ...BACKUP_TABLES]);
    const missing = GROVE_PROJECT_SCOPED_TABLES.filter((t) => !carriers.has(t));
    expect(missing).toEqual([]);
  });
});
