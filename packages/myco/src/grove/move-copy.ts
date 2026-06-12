/**
 * Move rekey copy — project-scoped row transfer between two Grove DBs.
 *
 * The backup engine's dump/restore pair cannot serve a move into a
 * non-empty target: dumps serialize literal AUTOINCREMENT integer ids
 * and restore with `INSERT OR IGNORE`, so colliding ids are silently
 * dropped and child rows attach to the wrong project's parents. This
 * copy reads the source rows directly and re-inserts them into the
 * target in one transaction, reallocating every integer primary key
 * and remapping the foreign-key columns that point at them.
 *
 * Text primary keys (sessions, spores, plans, ...) are globally unique
 * and copied as-is. FTS shadow tables are maintained by the INSERT
 * triggers on their base tables, so plain prepared INSERTs keep them
 * in sync — `*_fts` tables are never written directly.
 */

import type { Database } from 'bun:sqlite';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { sortRowsByParentChain } from './importer/parent-chain-sort.js';

/**
 * Tables the move copies, verifies, and cleans. The full project-scoped
 * registry — including `entity_mentions`, which the dump format excludes
 * (no `id` column) but a direct row copy carries fine.
 */
export const MOVE_COPY_TABLES: readonly string[] = GROVE_PROJECT_SCOPED_TABLES;

/**
 * Tables whose `INTEGER PRIMARY KEY AUTOINCREMENT` ids are reallocated
 * in the target. Guarded against schema drift by
 * tests/grove/move-copy.test.ts, which re-derives this set from the DDL.
 */
export const MOVE_REKEYED_TABLES = [
  'prompt_batches',
  'knowledge_git_provenance',
  'knowledge_release_state',
  'activities',
  'digest_extracts',
  'agent_reports',
  'agent_turns',
  'agent_run_write_intents',
  'digest_extract_revisions',
  'log_entries',
] as const;

const MOVE_REKEYED_TABLE_SET = new Set<string>(MOVE_REKEYED_TABLES);

export interface MoveFkRemap {
  /** Table carrying the foreign-key column. */
  table: string;
  /** Column holding an integer id into a rekeyed table. */
  column: string;
  /** Rekeyed table the column references. */
  via: string;
}

/**
 * Every foreign-key column that references a rekeyed table's integer id.
 * Drift-guarded against the DDL by tests/grove/move-copy.test.ts.
 */
export const MOVE_FK_REMAPS: readonly MoveFkRemap[] = [
  { table: 'prompt_batches', column: 'parent_prompt_batch_id', via: 'prompt_batches' },
  { table: 'knowledge_git_provenance', column: 'prompt_batch_id', via: 'prompt_batches' },
  { table: 'knowledge_release_state', column: 'source_prompt_batch_id', via: 'prompt_batches' },
  { table: 'activities', column: 'prompt_batch_id', via: 'prompt_batches' },
  { table: 'plans', column: 'prompt_batch_id', via: 'prompt_batches' },
  { table: 'attachments', column: 'prompt_batch_id', via: 'prompt_batches' },
  { table: 'spores', column: 'prompt_batch_id', via: 'prompt_batches' },
  { table: 'digest_extract_revisions', column: 'parent_revision_id', via: 'digest_extract_revisions' },
];

/** Self-referential parent columns requiring parents-before-children insert order. */
const SELF_FK_PARENT_COLUMNS: Record<string, string> = {
  prompt_batches: 'parent_prompt_batch_id',
  digest_extract_revisions: 'parent_revision_id',
};

type SqlValue = string | number | bigint | Uint8Array | null;

/**
 * True for SQLite's "no such table" — the ONLY skippable per-table error
 * (a missing table holds no rows for the project). Every other error must
 * surface: the same error swallowed symmetrically on both sides of the
 * move would let a skipped table pass count-verify as 0 == 0, after which
 * cleanup deletes the only copy of the rows.
 */
export function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no such table/i.test(message);
}

/**
 * Copy every row of the moved project from `sourceDb` into `targetDb`.
 *
 * Runs as ONE target transaction that first wipes any target rows for
 * `projectId` across the copy's table set, then inserts the source rows.
 * Target registration only happens at the move's commit phase, so the
 * project cannot legitimately have target rows yet — the wipe makes the
 * copy re-entrant after a crash between transaction commit and marker
 * write. Foreign keys are deferred for the duration (rows may reference
 * out-of-scope tables such as `agents`, copied separately).
 */
export function copyProjectBetweenGroveDbs(
  sourceDb: Database,
  targetDb: Database,
  projectId: string,
): void {
  targetDb.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = targetDb.transaction(() => {
      wipeProjectRows(targetDb, projectId);
      const idMaps = new Map<string, Map<number, number>>();
      for (const table of MOVE_COPY_TABLES) {
        copyTable(sourceDb, targetDb, table, projectId, idMaps);
      }
    });
    tx();
  } finally {
    targetDb.run('PRAGMA foreign_keys = ON');
  }
}

/**
 * Delete every row for `projectId` across the move's table set, in its
 * own transaction with foreign keys deferred. Used for the move's
 * source-cleanup phase and for rolling the target back after a failed
 * move. Per-table errors are collected and thrown together — a failed
 * delete must surface, not silently leave rows behind. The transaction
 * makes the deletion all-or-nothing.
 */
export function deleteProjectRowsForMove(db: Database, projectId: string): void {
  db.run('PRAGMA foreign_keys = OFF');
  try {
    const tx = db.transaction(() => wipeProjectRows(db, projectId));
    tx();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

/**
 * Post-copy integrity check: rows whose remapped foreign key does not
 * resolve to a parent row of the same project. Structurally impossible
 * after a correct rekey copy — any hit means the copy is broken and the
 * move must not commit.
 */
export function findOrphanRemappedRows(db: Database, projectId: string): string[] {
  const problems: string[] = [];
  for (const { table, column, via } of MOVE_FK_REMAPS) {
    let row: { n: number } | undefined;
    try {
      row = db.prepare(
        `SELECT COUNT(*) AS n FROM ${table} child
         WHERE child.project_id = ?
           AND child.${column} IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ${via} parent
             WHERE parent.id = child.${column} AND parent.project_id = ?
           )`,
      ).get(projectId, projectId) as { n: number } | undefined;
    } catch (err) {
      // A missing table has nothing to check; any other error blinds the
      // orphan check and must fail the verify it serves.
      if (isMissingTableError(err)) continue;
      throw new Error(
        `orphan check failed reading ${table}.${column}: `
        + (err instanceof Error ? err.message : String(err)),
      );
    }
    const count = row?.n ?? 0;
    if (count > 0) {
      problems.push(`${table}.${column}: ${count} row(s) reference a missing ${via} parent`);
    }
  }
  return problems;
}

function wipeProjectRows(db: Database, projectId: string): void {
  const failures: string[] = [];
  for (const table of MOVE_COPY_TABLES) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    } catch (err) {
      // A missing table holds no rows for the project — nothing to delete.
      if (isMissingTableError(err)) continue;
      failures.push(`${table}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `failed to delete rows for project ${projectId}: ${failures.join('; ')}`,
    );
  }
}

function copyTable(
  sourceDb: Database,
  targetDb: Database,
  table: string,
  projectId: string,
  idMaps: Map<string, Map<number, number>>,
): void {
  let rows: Record<string, unknown>[];
  try {
    rows = sourceDb.prepare(
      `SELECT * FROM ${table} WHERE project_id = ?`,
    ).all(projectId) as Record<string, unknown>[];
  } catch (err) {
    // A table absent from an older source schema has nothing to copy.
    // Any other read error (corrupt table, missing column) must abort
    // the move — see isMissingTableError.
    if (isMissingTableError(err)) return;
    throw new Error(
      `failed to read ${table} rows for project ${projectId}: `
      + (err instanceof Error ? err.message : String(err)),
    );
  }
  if (rows.length === 0) return;

  const selfFkColumn = SELF_FK_PARENT_COLUMNS[table];
  if (selfFkColumn) {
    rows = sortRowsByParentChain(
      rows,
      table,
      (row) => row.id as number,
      (row) => row[selfFkColumn] as number | null,
    );
  }

  const targetColumns = tableColumns(targetDb, table);
  const rekey = MOVE_REKEYED_TABLE_SET.has(table);
  const remaps = MOVE_FK_REMAPS.filter((r) => r.table === table && targetColumns.has(r.column));
  // Columns the source rows carry AND the target schema knows; the
  // reallocated integer id is omitted so the target assigns a fresh one.
  const columns = Object.keys(rows[0]).filter(
    (c) => targetColumns.has(c) && !(rekey && c === 'id'),
  );
  const insert = targetDb.prepare(
    `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})`,
  );
  const map = rekey ? mapFor(idMaps, table) : null;

  for (const row of rows) {
    const out: Record<string, unknown> = { ...row };
    for (const remap of remaps) {
      out[remap.column] = remapFkValue(sourceDb, idMaps, remap, out[remap.column], row.id);
    }
    const result = insert.run(...columns.map((c) => out[c] as SqlValue));
    if (map) map.set(row.id as number, Number(result.lastInsertRowid));
  }
}

function mapFor(idMaps: Map<string, Map<number, number>>, table: string): Map<number, number> {
  let map = idMaps.get(table);
  if (!map) {
    map = new Map<number, number>();
    idMaps.set(table, map);
  }
  return map;
}

function remapFkValue(
  sourceDb: Database,
  idMaps: Map<string, Map<number, number>>,
  remap: MoveFkRemap,
  value: unknown,
  childRowId: unknown,
): number | null {
  if (value === null || value === undefined) return null;
  const sourceId = Number(value);
  const mapped = idMaps.get(remap.via)?.get(sourceId);
  if (mapped === undefined) {
    // The referenced parent is not part of the moved project's row set.
    // Copying the literal id would attach the row to an arbitrary target
    // parent — refuse and let the move's failure path roll back. The
    // message names the polluted row and its foreign parent so manual
    // triage (repair or delete the row in the source Grove) is possible
    // without re-deriving the lineage.
    throw new Error(
      `${remap.table}.${remap.column} references ${remap.via} id ${sourceId}, `
      + `which is not part of the moved project's rows `
      + `(${remap.table} row id ${String(childRowId)}; ${describeForeignParent(sourceDb, remap.via, sourceId)}). `
      + `Repair or delete that ${remap.table} row in the source Grove, then retry the move.`,
    );
  }
  return mapped;
}

/** Triage detail for an out-of-scope FK parent: who owns it, if anyone. */
function describeForeignParent(sourceDb: Database, table: string, id: number): string {
  let row: { project_id: string | null } | undefined;
  try {
    row = sourceDb.prepare(
      `SELECT project_id FROM ${table} WHERE id = ?`,
    ).get(id) as { project_id: string | null } | undefined;
  } catch {
    return `the ${table} parent could not be inspected`;
  }
  if (!row) return `no ${table} row with that id exists in the source`;
  if (row.project_id === null || row.project_id === '') {
    return `the ${table} parent carries no project_id`;
  }
  return `the ${table} parent belongs to project ${row.project_id}`;
}

function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
