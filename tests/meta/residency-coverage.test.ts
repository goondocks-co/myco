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
import { RESIDENCY_APPLY_RULES, RESIDENCY_SIDECARS, RESIDENCY_TABLE_ORDER, applyResidencyRows } from '@myco/db/queries/residency-apply.js';
import { backfillProjectForResidency, listSidecarPage } from '@myco/db/queries/residency-backfill.js';
import { listPendingForProject } from '@myco/db/queries/team-outbox.js';
import { getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { setupTestDb, teardownTestDb } from '../helpers/db';

const PROJ = 'proj_cccccccccccccccccccccccccccccccc';

/**
 * Every table the attach push must carry — the project-scoped set plus
 * `content_publications`, which has no `project_id` and so is absent from that
 * constant while still being shipped AND deleted (`deleteAfterAck` removes it via
 * its own artifact-scoped helper). Asserting only the scoped set would leave the
 * one table whose structural oddity caused the original bug unchecked.
 */
/** A column that records WHEN, not WHAT. Held fixed between siblings so the
 *  gate tests two rows written in the same second. */
const TIMESTAMP_COLUMN = /(^|_)(at|timestamp|time)$/;

const CARRIED_TABLES: readonly string[] = [...GROVE_PROJECT_SCOPED_TABLES, 'content_publications'];

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

/** Columns covered by a single-column UNIQUE index. */
function uniqueColumns(db: Database, table: string): Set<string> {
  const out = new Set<string>();
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  for (const idx of indexes) {
    if (!idx.unique) continue;
    const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length === 1 && cols[0]) out.add(cols[0]);
  }
  return out;
}

/** The payload columns of `table`: everything that is not scope, not a parent
 *  reference, not a timestamp, and not the dropped autoincrement id. These are
 *  the columns that differ between two capture rows written in the same second. */
function payloadColumns(db: Database, table: string): string[] {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }>;
  return info
    .filter((c) => !(c.pk > 0 && c.type.toUpperCase().includes('INT')))
    .filter((c) => c.name !== 'project_id' && !c.name.endsWith('_id') && !TIMESTAMP_COLUMN.test(c.name))
    .filter((c) => c.pk > 0 || (c.notnull === 1 && c.dflt_value == null) || c.type.toUpperCase().includes('TEXT'))
    .map((c) => c.name);
}

/**
 * A sibling of the seeded row differing in EXACTLY ONE payload column.
 *
 * One column at a time, rather than all of them at once, and that is the whole
 * design. A sibling that varies every payload column is separated by any ONE of
 * them appearing in the dedupe tuple — so `activities`, keyed on
 * (scope, parents, `tool_name`, `timestamp`) with a NULL `content_hash`, passed
 * a vary-everything gate while merging eight same-second `Read` calls into three
 * rows on the rig. Those calls shared `tool_name` and differed in `file_path`,
 * which the tuple did not carry. Varying one column at a time asserts the real
 * property: ANY single payload difference must survive the trip.
 *
 * Scope, parents and timestamps stay identical throughout — two rows from the
 * same second, which is capture's ordinary output rather than an edge case.
 */
function seedSiblingVarying(db: Database, table: string, vary: string, seq: number): void {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }>;
  // A UNIQUE column is varied ALONGSIDE the target: two genuinely distinct rows
  // must differ there or the source insert is illegal
  // (`knowledge_git_provenance.identity_key`). Varying it does not weaken the
  // test — the question is still whether the RECEIVER keeps both rows.
  const unique = uniqueColumns(db, table);
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const col of info) {
    if (col.pk > 0 && col.type.toUpperCase().includes('INT')) continue;
    const isFixed = col.name === 'project_id' || col.name.endsWith('_id') || TIMESTAMP_COLUMN.test(col.name);
    const required = col.pk > 0 || (col.notnull === 1 && col.dflt_value == null);
    if (col.name !== vary && !required && !isFixed) continue;

    cols.push(col.name);
    const t = col.type.toUpperCase();
    if (col.name === vary || unique.has(col.name)) {
      // `seq` keeps each sibling distinct from the others, not just from the
      // original — otherwise the second one collides on the UNIQUE column.
      vals.push(t.includes('INT') ? 90 + seq : t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') ? 90 + seq : `${table}_${col.name}_varied_${seq}`);
      continue;
    }
    if (col.name === 'project_id') { vals.push(PROJ); continue; }
    const seeded = SEED_OVERRIDES[table]?.[col.name];
    if (seeded !== undefined) { vals.push(seeded); continue; }
    // Byte-identical to the original row in every non-varied column.
    vals.push(t.includes('INT') ? 1 : t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') ? 1.0 : `${table}_${col.name}`);
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


/**
 * A row of `table` where EVERY column carries a value of its DECLARED TYPE,
 * nullable content columns included — the shape realistic capture produces and
 * the shape the fidelity gate needs. Returns what it wrote so a round-trip can
 * be compared value-for-value.
 *
 * `seedRow` above only fills NOT-NULL-without-default columns and types every
 * TEXT-ish value as a string; both blind spots shipped data loss — a BLOB
 * (`attachments.data`) tested as TEXT, and stripped nullable columns
 * (`knowledge_release_state.basis_ref/basis_sha/evidence_json`) never populated
 * so their loss was invisible.
 */
function seedRealisticRow(db: Database, table: string): Record<string, unknown> {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string; type: string; notnull: number; dflt_value: unknown; pk: number;
  }>;
  const overrides = SEED_OVERRIDES[table] ?? {};
  const written: Record<string, unknown> = {};
  for (const col of info) {
    const t = col.type.toUpperCase();
    if (col.name in overrides) { written[col.name] = overrides[col.name]; continue; }
    if (col.name === 'project_id') { written[col.name] = PROJ; continue; }
    if (col.pk > 0) { written[col.name] = t.includes('INT') ? 1 : `${table}_row_1`; continue; }
    if (t.includes('BLOB')) { written[col.name] = new Uint8Array([0, 1, 2, 253, 254, 255]); continue; }
    if (t.includes('INT')) { written[col.name] = 7; continue; }
    if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) { written[col.name] = 1.5; continue; }
    written[col.name] = `${table}_${col.name}_value`;
  }
  const cols = Object.keys(written);
  db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => written[c] as never));
  return written;
}

/** Columns whose value the RECEIVER legitimately transforms, so a fidelity
 *  compare must ignore them: the reassigned autoincrement id (local-rowid
 *  tables only), the receiver clock stamp, and the local-only sync marker. */
function bookkeepingColumns(table: string): Set<string> {
  const cols = new Set<string>(['received_at', 'synced_at']);
  const rule = RESIDENCY_APPLY_RULES[table] as { kind: string; selfRef?: string } | undefined;
  if (rule?.kind === 'local-rowid') {
    cols.add('id'); // reassigned by the receiver's AUTOINCREMENT
    // A self-reference is remapped to the parent's RECEIVER id, or nulled when
    // the parent is outside this batch — a single-row seed always nulls it.
    // Its remapping correctness is gated in routed-residency.test.ts, not here.
    if (rule.selfRef) cols.add(rule.selfRef);
  }
  return cols;
}

function bytesEqual(a: unknown, b: unknown): boolean {
  const ba = a instanceof Uint8Array ? Buffer.from(a) : Buffer.isBuffer(a) ? a : null;
  const bb = b instanceof Uint8Array ? Buffer.from(b) : Buffer.isBuffer(b) ? b : null;
  if (ba && bb) return ba.equals(bb);
  return false;
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
      for (const table of CARRIED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) missing.push(`${table} (received ${c} of 1)`);
      }
      expect(missing).toEqual([]);
      target.close();
    });
  });


  test('DIRECTION PARITY: attach and detach carry the SAME canonical table set', () => {
    // The one-level-up version of #842. Attach and detach each defined their own
    // set: attach carries GROVE_PROJECT_SCOPED_TABLES + content_publications, the
    // detach artifact carries GROVE_PROJECT_SCOPED_TABLES alone — so a project
    // with published skills attached, then detached, lost content_publications
    // permanently (it has no project_id, so it fell out of the detach set). Two
    // directions asserting different sets is exactly the asymmetry the table
    // parity work was meant to end; assert them equal so neither can drift.
    const attachCarried = [...RESIDENCY_TABLE_ORDER].sort();
    const detachCarried = [...DETACH_ARTIFACT_TABLES].sort();
    expect(detachCarried).toEqual(attachCarried);
  });

  test('ATTACH FIDELITY: every content column survives send -> apply, at its real type', () => {
    // Table presence is necessary, not sufficient. `attachments.data` is a BLOB;
    // the push JSON-encodes it to {"0":..} and the receiver bind THROWS, wedging
    // attach on any vault with an attachment. `knowledge_release_state`'s
    // basis_ref/basis_sha/evidence_json are stripped by the team-SYNC sanitizer
    // the residency push borrowed, then deleted locally — gone on a lossless-by-
    // contract round trip. Seed a realistic row of each carried table, drive the
    // REAL send + apply, and assert every content column arrives byte-for-byte
    // (ignoring the columns the receiver legitimately transforms).
    setupTestDb();
    try {
      const source = getDatabase();
      source.exec('PRAGMA foreign_keys = OFF');
      const expected = new Map<string, Record<string, unknown>>();
      for (const table of GROVE_PROJECT_SCOPED_TABLES) expected.set(table, seedRealisticRow(source, table));
      expected.set('content_publications', seedRealisticRow(source, 'content_publications'));

      const target = new Database(':memory:');
      createSchema(target, 'host_machine');
      target.exec('PRAGMA foreign_keys = OFF');
      const scope = { expectedProjectId: PROJ };

      backfillProjectForResidency(PROJ, 'member_machine');
      for (const row of listPendingForProject(PROJ)) {
        applyResidencyRows(target, row.table_name, [row.payload], scope);
      }
      for (const sidecar of RESIDENCY_SIDECARS) {
        let cursor: string | null = null;
        do {
          const page = listSidecarPage(sidecar, PROJ, cursor);
          if (page.rows.length > 0) applyResidencyRows(target, sidecar.table, page.rows, scope);
          cursor = page.nextCursor;
        } while (cursor !== null);
      }

      const lost: string[] = [];
      for (const [table, want] of expected) {
        const ignore = bookkeepingColumns(table);
        const got = target.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as Record<string, unknown> | undefined;
        if (!got) { lost.push(`${table}: no row arrived`); continue; }
        for (const [col, wantVal] of Object.entries(want)) {
          if (ignore.has(col)) continue;
          const gotVal = got[col];
          const ok = wantVal instanceof Uint8Array ? bytesEqual(wantVal, gotVal) : gotVal === wantVal;
          if (!ok) lost.push(`${table}.${col}: sent ${JSON.stringify(wantVal)}, host has ${JSON.stringify(gotVal)}`);
        }
      }
      expect(lost).toEqual([]);
      target.close();
    } finally {
      teardownTestDb();
    }
  });


  test('DETACH FIDELITY: content_publications rides the artifact, scoped by its owning skill', () => {
    // The behavioral lock for the parity fix. content_publications has no
    // project_id, so a project-scoped detach must reach it through the owning
    // artifact (skill_records/okf_pages) — the same resolution attach uses.
    // Also asserts scoping: a DIFFERENT project's publication must NOT ride this
    // project's artifact.
    const source = new Database(':memory:');
    createSchema(source, 'local');
    source.exec('PRAGMA foreign_keys = OFF');
    // Two skills: one in PROJ, one in another project; one publication each.
    source.prepare(`INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at) VALUES ('skill_mine', ?, 'user', 'a', 'A', 'd', 'p', 1, 1)`).run(PROJ);
    source.prepare(`INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at) VALUES ('skill_other', 'proj_other0000000000000000000000', 'user', 'b', 'B', 'd', 'p', 1, 1)`).run();
    const pub = source.prepare(`INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id) VALUES ('skill', ?, 1, 1, 'user', 'local')`);
    pub.run('skill_mine');
    pub.run('skill_other');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detach-cp-'));
    try {
      const dump = createBackup(source, dir, 'machine_test', projectScope(PROJ), 'coverage', DETACH_ARTIFACT_TABLES);
      const target = new Database(':memory:');
      createSchema(target, 'local');
      restoreBackup(target, dump);
      const rows = target.prepare(`SELECT artifact_id FROM content_publications`).all() as Array<{ artifact_id: string }>;
      expect(rows.map((r) => r.artifact_id)).toEqual(['skill_mine']);
      target.close();
    } finally {
      source.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      for (const table of CARRIED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) duplicated.push(`${table} (${c} rows after replay)`);
      }
      expect(duplicated).toEqual([]);
      target.close();
    });
  });

  test('SIBLING ROWS: any SINGLE payload difference survives, at identical timestamps', () => {
    // The gate the rig had to teach. One seeded row per table is blind to a
    // dedupe tuple that SHRANK, and a sibling varying EVERY payload column is
    // blind to one that is merely too narrow — any single carried column
    // separates it. `activities` passed both while merging eight same-second
    // `Read` calls into three rows on the host: they shared `tool_name` and
    // differed in `file_path`, which the tuple did not carry.
    //
    // So: for every payload column, a sibling differing in THAT COLUMN ALONE,
    // with scope, parents and timestamps held identical. Both rows must arrive.
    withSeededProject((source) => {
      const localRowid = Object.entries(RESIDENCY_APPLY_RULES)
        .filter(([, rule]) => rule.kind === 'local-rowid')
        .map(([table]) => table);
      expect(localRowid.length).toBeGreaterThan(0);

      const expected = new Map<string, number>();
      for (const table of localRowid) {
        const payload = payloadColumns(source, table);
        expect(payload.length, `${table} has no payload column to vary`).toBeGreaterThan(0);
        payload.forEach((col, i) => seedSiblingVarying(source, table, col, i + 1));
        expected.set(table, 1 + payload.length);
      }

      const target = new Database(':memory:');
      createSchema(target, 'host_machine');
      target.exec('PRAGMA foreign_keys = OFF');
      const scope = { expectedProjectId: PROJ };

      backfillProjectForResidency(PROJ, 'member_machine');
      for (const row of listPendingForProject(PROJ)) {
        applyResidencyRows(target, row.table_name, [row.payload], scope);
      }

      const merged: string[] = [];
      for (const [table, want] of expected) {
        const got = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (got !== want) {
          merged.push(`${table} (received ${got} of ${want} — dedupe tuple carries no column that separates these)`);
        }
      }
      expect(merged).toEqual([]);
      target.close();
    });
  });

  test('NEGATIVE CONTROL: a carried set missing a table makes the gate\'s own predicate go red', () => {
    // Skipping a table and asserting zero rows arrive is near-tautological —
    // `applyResidencyRows` is the only writer. What needs demonstrating is that
    // the MAIN gate's predicate turns red, so this recomputes that predicate
    // against a shipping set with `activities` removed and requires it to name
    // the table. If the gate could ever be satisfied without carriage, this
    // fails.
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
      for (const sidecar of RESIDENCY_SIDECARS) {
        let cursor: string | null = null;
        do {
          const page = listSidecarPage(sidecar, PROJ, cursor);
          if (page.rows.length > 0) applyResidencyRows(target, sidecar.table, page.rows, scope);
          cursor = page.nextCursor;
        } while (cursor !== null);
      }

      // The MAIN gate's predicate, verbatim.
      const missing: string[] = [];
      for (const table of CARRIED_TABLES) {
        const c = (target.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        if (c !== 1) missing.push(`${table} (received ${c} of 1)`);
      }
      expect(missing).toEqual(['activities (received 0 of 1)']);
      target.close();
    });
  });
});
