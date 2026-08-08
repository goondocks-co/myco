/**
 * Residency backfill — enqueue a project's rows for the attach push (Phase F).
 *
 * When a project with local history attaches to a Team Host, every sync-eligible
 * row of that project is queued into `team_outbox` for the residency drain to
 * ship (`host/residency-drain.ts`). This is the `backfillRows` project arm
 * MINUS the `team_sync_membership` join (empty post-v72 — joining it yields zero
 * rows) and MINUS team-id semantics (residency rows carry a null `team_id`).
 * The `sanitizeSyncPayload` strip is preserved: host copies are deliberately
 * free of local-only columns, exactly as team sync always shipped them.
 *
 * The sidecar tables — those with no `id`, plus `entity_mentions`, which has one the
 * outbox deliberately does not carry — cannot ride the outbox, whose contract is a
 * single `id` column. They are paged directly by the drain via {@link listSidecarPage}
 * and shipped over the same route with journal cursors. Which tables those are, and
 * the key each pages by, is declared once in `RESIDENCY_SIDECARS`.
 *
 * Every function assumes it runs under `withDatabase(sourceGroveDb, …)`
 * (daemon-owned): `getDatabase()` resolves to the source Grove connection.
 */
import { epochSeconds } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import {
  PROJECT_ARTIFACT_IDS_SQL,
  RESIDENCY_OUTBOX_TABLES,
  RESIDENCY_SIDECARS,
  type ResidencySidecar,
} from '@myco/db/queries/residency-apply.js';
import {
  insertOutboxRowsForUpsert,
  sanitizeSyncPayload,
} from '@myco/db/queries/team-outbox.js';

/** Default rows per sidecar page — comfortably under the 8MB per-request cap. */
export const RESIDENCY_SIDECAR_PAGE_SIZE = 500;

/**
 * Enqueue every outbox-eligible row of `projectId` into `team_outbox` as `upsert`
 * records with a null `team_id`. Idempotent: a row already pending (a resumed
 * transition re-running this) is skipped via the outbox NOT-EXISTS guard, so a
 * crash-resume never double-enqueues. Returns the number of rows enqueued.
 *
 * Iterates `RESIDENCY_OUTBOX_TABLES` — the carried set minus the sidecars, which the
 * drain pages separately. The carried set is itself derived from the tables the
 * post-push delete sweeps, so a table added to the schema is enqueued here without a
 * second list to remember.
 */
export function backfillProjectForResidency(projectId: string, machineId: string): number {
  const db = getDatabase();
  const now = epochSeconds();
  let total = 0;

  for (const table of RESIDENCY_OUTBOX_TABLES) {
    const rows = db.prepare(
      `SELECT ${table}.*
         FROM ${table}
        WHERE ${table}.project_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM team_outbox
             WHERE team_outbox.table_name = ?
               AND team_outbox.row_id = CAST(${table}.id AS TEXT)
               AND team_outbox.sent_at IS NULL
          )`,
    ).all(projectId, table) as Record<string, unknown>[];

    if (rows.length === 0) continue;
    // insertOutboxRowsForUpsert reads `__myco_team_id` for the team id and
    // defaults null when absent — residency rows carry none, so they enqueue
    // team-id-less, and it applies the same sanitizeSyncPayload strip.
    insertOutboxRowsForUpsert(db, table, rows, machineId, now);
    total += rows.length;
  }

  return total;
}

/** One page of sidecar rows plus the resume token for the next page (null at end). */
export interface ResidencySidecarPage {
  rows: Record<string, unknown>[];
  nextCursor: string | null;
}

function decodeCursor(cursor: string | null): string[] | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null;
  } catch {
    return null;
  }
}

/**
 * Page one sidecar stream for a project, ordered and cursored by the table's declared
 * `key`. The cursor is the JSON-encoded key tuple of the last row of the previous
 * page; `null` starts from the beginning and comes back `null` once the final (short)
 * page is returned.
 *
 * ONE pager rather than one per table: the two hand-written enumerators this replaced
 * differed only in table name, key tuple and scope clause, so every table added to
 * `RESIDENCY_SIDECARS` would otherwise have been another near-copy to keep in step
 * with cursor handling. The key tuple is interpolated into SQL, which is safe because
 * `RESIDENCY_SIDECARS` is a module constant — never a caller-supplied name.
 */
export function listSidecarPage(
  sidecar: ResidencySidecar,
  projectId: string,
  cursor: string | null,
  pageSize: number = RESIDENCY_SIDECAR_PAGE_SIZE,
): ResidencySidecarPage {
  const db = getDatabase();
  const after = decodeCursor(cursor);
  const key = sidecar.key;
  const scopeClause = sidecar.scope === 'artifact'
    ? `artifact_id IN (${PROJECT_ARTIFACT_IDS_SQL})`
    : 'project_id = ?';
  // The artifact arm binds the project id once per UNION arm; the project arm once.
  const scopeParams = sidecar.scope === 'artifact' ? [projectId, projectId] : [projectId];
  const cursorClause = after
    ? ` AND (${key.join(', ')}) > (${key.map(() => '?').join(', ')})`
    : '';
  const rows = db.prepare(
    `SELECT * FROM ${sidecar.table}
      WHERE ${scopeClause}${cursorClause}
      ORDER BY ${key.join(', ')}
      LIMIT ?`,
  ).all(...scopeParams, ...(after ?? []), pageSize) as Record<string, unknown>[];

  const last = rows[rows.length - 1];
  const nextCursor = rows.length < pageSize
    ? null
    : JSON.stringify(key.map((c) => last![c]));
  return { rows: rows.map((r) => sanitizeSyncPayload(sidecar.table, r)), nextCursor };
}

/**
 * Delete a project's `content_publications` rows once the host has the full
 * push. The table is not in `GROVE_PROJECT_SCOPED_TABLES` (no `project_id`), so
 * the project-scoped delete sweep would otherwise leave these rows orphaned
 * against artifacts it does delete. Must run BEFORE the artifact tables are
 * deleted — the join that scopes it depends on those rows still existing.
 * Returns the number of rows removed.
 */
export function deleteContentPublicationsForProject(projectId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    `DELETE FROM content_publications
      WHERE artifact_id IN (${PROJECT_ARTIFACT_IDS_SQL})`,
  ).run(projectId, projectId);
  return result.changes;
}
