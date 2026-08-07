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
import { DETACH_ARTIFACT_TABLES, createBackup, restoreBackup, projectScope } from '@myco/backup/engine.js';
import { RESIDENCY_SIDECARS, applyResidencyRows } from '@myco/db/queries/residency-apply.js';
import { backfillProjectForResidency, listSidecarPage } from '@myco/db/queries/residency-backfill.js';
import { listPendingForProject } from '@myco/db/queries/team-outbox.js';
import { getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { setupTestDb, teardownTestDb } from '../helpers/db';

const PROJ = 'proj_cccccccccccccccccccccccccccccccc';

/**
 * Columns whose seeded value must MATCH another seeded row rather than be
 * type-shaped. Both are tables the receiver validates against a parent it looks up
 * by id (`entity_mentions` -> `entities`, `content_publications` -> the artifact
 * tables), so an arbitrary value is refused as an absent parent and the table's
 * carriage would never be exercised.
 */
const SEED_OVERRIDES: Readonly<Record<string, Record<string, unknown>>> = {
  entity_mentions: { entity_id: 'entities_row_1' },
  content_publications: { artifact_kind: 'skill', artifact_id: 'skill_records_row_1' },
};

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
  const overrides = SEED_OVERRIDES[table] ?? {};
  for (const col of info) {
    if (col.name in overrides) { cols.push(col.name); vals.push(overrides[col.name]); continue; }
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

/**
 * Run `fn` against an ambient source vault holding exactly one row in every
 * project-scoped table plus `content_publications`. Ambient rather than a local
 * handle because the send path (`backfillProjectForResidency`, `listSidecarPage`)
 * resolves its connection through `getDatabase()` — the same way the drain calls it.
 */
function withSeededProject(fn: (source: Database) => void): void {
  setupTestDb();
  try {
    const source = getDatabase();
    // FKs off for seeding: values are synthetic, so referential order is irrelevant.
    source.exec('PRAGMA foreign_keys = OFF');
    for (const table of GROVE_PROJECT_SCOPED_TABLES) seedRow(source, table);
    // Not project-scoped (no `project_id`), but carried and deleted alongside them.
    seedRow(source, 'content_publications');
    fn(source);
  } finally {
    teardownTestDb();
  }
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
      const dump = createBackup(source, dir, 'machine_test', projectScope(PROJ), 'coverage', DETACH_ARTIFACT_TABLES);

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

  test('ATTACH (behavioral): the push carries EVERY table the post-push delete removes, one row each, by name', () => {
    // Deliberately NOT the union form (`push ∪ backup ⊇ scoped`) this file's own
    // docstring calls blind. The union credited BACKUP_TABLES, which in the attach
    // direction is the member's local pre-attach dump — a file on the departing
    // machine that never reaches the host. It therefore covered every table by
    // itself, so RESIDENCY_TABLE_ORDER could have shrunk to nothing and this still
    // passed. It did pass, for seventeen tables, including `activities`.
    //
    // Behavioral for the same reason the detach gate is: membership proves a name is
    // in a list, not that the row can be enumerated, shipped and applied. This drives
    // the real send path (`backfillProjectForResidency` + `listSidecarPage`) into the
    // real receiver (`applyResidencyRows`) and then asserts against the real delete
    // set (`GROVE_PROJECT_SCOPED_TABLES`, which is what `deleteAfterAck` sweeps).
    withSeededProject(() => {
      const target = new Database(':memory:');
      createSchema(target, 'host_machine');
      // FK-off on the receiver: the seeded values are synthetic, so parent rows do
      // not satisfy child references. FK ORDER is a different property with its own
      // gate (tests/host/routed-residency.test.ts); what is under test here is
      // whether each table's rows arrive at all.
      target.exec('PRAGMA foreign_keys = OFF');

      const scope = { expectedProjectId: PROJ };
      // (1) outbox-riding tables, in the drain's order.
      backfillProjectForResidency(PROJ, 'member_machine');
      for (const row of listPendingForProject(PROJ)) {
        applyResidencyRows(target, row.table_name, [row.payload], scope);
      }
      // (2) sidecars, paged exactly as the drain pages them.
      for (const sidecar of RESIDENCY_SIDECARS) {
        let cursor: string | null = null;
        do {
          const page = listSidecarPage(sidecar, PROJ, cursor);
          if (page.rows.length > 0) applyResidencyRows(target, sidecar.table, page.rows, scope);
          cursor = page.nextCursor;
        } while (cursor !== null);
      }

      const missing: string[] = [];
      for (const table of GROVE_PROJECT_SCOPED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) missing.push(`${table} (received ${c} of 1)`);
      }
      expect(missing).toEqual([]);
      target.close();
    });
  });

  test('ATTACH is replay-safe: shipping the same rows twice leaves one row per table', () => {
    // The push is retried on any failed POST, and the local-rowid tables drop their
    // sender id — so nothing but the declared dedupe key stands between a retry and
    // a duplicated row. A too-narrow key silently drops rows; a too-wide one
    // silently doubles them. Both show up here.
    withSeededProject(() => {
      const target = new Database(':memory:');
      createSchema(target, 'host_machine');
      target.exec('PRAGMA foreign_keys = OFF');
      const scope = { expectedProjectId: PROJ };

      backfillProjectForResidency(PROJ, 'member_machine');
      const outbox = listPendingForProject(PROJ);
      for (const pass of [1, 2]) {
        void pass;
        for (const row of outbox) applyResidencyRows(target, row.table_name, [row.payload], scope);
        for (const sidecar of RESIDENCY_SIDECARS) {
          let cursor: string | null = null;
          do {
            const page = listSidecarPage(sidecar, PROJ, cursor);
            if (page.rows.length > 0) applyResidencyRows(target, sidecar.table, page.rows, scope);
            cursor = page.nextCursor;
          } while (cursor !== null);
        }
      }

      const duplicated: string[] = [];
      for (const table of GROVE_PROJECT_SCOPED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) duplicated.push(`${table} (${c} rows after replay)`);
      }
      expect(duplicated).toEqual([]);
      target.close();
    });
  });

  test('NEGATIVE CONTROL: dropping a table from the carried set fails the attach gate', () => {
    // The gate above is only worth its runtime if removing carriage actually turns
    // it red. `activities` is the table that was really lost, so it is the one used.
    withSeededProject(() => {
      const target = new Database(':memory:');
      createSchema(target, 'host_machine');
      target.exec('PRAGMA foreign_keys = OFF');
      const scope = { expectedProjectId: PROJ };

      backfillProjectForResidency(PROJ, 'member_machine');
      for (const row of listPendingForProject(PROJ)) {
        if (row.table_name === 'activities') continue; // the simulated regression
        applyResidencyRows(target, row.table_name, [row.payload], scope);
      }
      const count = (target.prepare(`SELECT COUNT(*) AS c FROM activities`).get() as { c: number }).c;
      expect(count).toBe(0);
      target.close();
    });
  });
});
