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
 * The two sidecar tables — `entity_mentions` (id-keyed as of v75 but with no
 * `synced_at` outbox wiring; identity is the four-column UNIQUE) and
 * `content_publications` (no `project_id`, keyed by
 * `(artifact_kind, artifact_id)`) — cannot ride the outbox, whose contract is
 * `id`+`synced_at`. They are paged directly by the drain via the enumerators
 * here and shipped over the same route with journal cursors.
 *
 * Every function assumes it runs under `withDatabase(sourceGroveDb, …)`
 * (daemon-owned): `getDatabase()` resolves to the source Grove connection.
 */
import { epochSeconds } from '@myco/constants.js';
import { getDatabase } from '@myco/db/client.js';
import { PROJECT_ARTIFACT_IDS_SQL } from '@myco/db/queries/residency-apply.js';
import {
  REBUILD_TABLES,
  insertOutboxRowsForUpsert,
  sanitizeSyncPayload,
} from '@myco/db/queries/team-outbox.js';

/** Default rows per sidecar page — comfortably under the 8MB per-request cap. */
export const RESIDENCY_SIDECAR_PAGE_SIZE = 500;

/**
 * Enqueue every sync-eligible row of `projectId` into `team_outbox` as `upsert`
 * records with a null `team_id`. Idempotent: a row already pending (a resumed
 * transition re-running this) is skipped via the outbox NOT-EXISTS guard, so a
 * crash-resume never double-enqueues. Returns the number of rows enqueued.
 *
 * `team_members` (the machine-scoped roster) is skipped — it has no `project_id`
 * and is never part of a single project's residency.
 */
export function backfillProjectForResidency(projectId: string, machineId: string): number {
  const db = getDatabase();
  const now = epochSeconds();
  let total = 0;

  for (const table of REBUILD_TABLES) {
    if (table === 'team_members') continue;

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
 * Page `entity_mentions` for a project by its four-column UNIQUE key
 * `(entity_id, note_id, note_type, agent_id)` — the only stable order available
 * for a table with no `id`. The cursor is the JSON-encoded key of the last row
 * of the previous page; `null` starts from the beginning and comes back `null`
 * once the final (short) page is returned.
 */
export function listEntityMentionPages(
  projectId: string,
  cursor: string | null,
  pageSize: number = RESIDENCY_SIDECAR_PAGE_SIZE,
): ResidencySidecarPage {
  const db = getDatabase();
  const after = decodeCursor(cursor);
  const cursorClause = after
    ? ' AND (entity_id, note_id, note_type, agent_id) > (?, ?, ?, ?)'
    : '';
  const params: unknown[] = after ? [projectId, ...after] : [projectId];
  const rows = db.prepare(
    `SELECT * FROM entity_mentions
      WHERE project_id = ?${cursorClause}
      ORDER BY entity_id, note_id, note_type, agent_id
      LIMIT ?`,
  ).all(...params, pageSize) as Record<string, unknown>[];

  const nextCursor = rows.length < pageSize
    ? null
    : JSON.stringify([
        rows[rows.length - 1].entity_id,
        rows[rows.length - 1].note_id,
        rows[rows.length - 1].note_type,
        rows[rows.length - 1].agent_id,
      ]);
  return { rows: rows.map((r) => sanitizeSyncPayload('entity_mentions', r)), nextCursor };
}

/**
 * Page `content_publications` for a project by its PK `(artifact_kind,
 * artifact_id)`. The table has no `project_id`; scope is resolved through the
 * owning artifact (`skill_records` / `okf_pages`). Cursor semantics match
 * {@link listEntityMentionPages}.
 */
export function listContentPublicationPages(
  projectId: string,
  cursor: string | null,
  pageSize: number = RESIDENCY_SIDECAR_PAGE_SIZE,
): ResidencySidecarPage {
  const db = getDatabase();
  const after = decodeCursor(cursor);
  const cursorClause = after ? ' AND (cp.artifact_kind, cp.artifact_id) > (?, ?)' : '';
  const params: unknown[] = [projectId, projectId, ...(after ?? [])];
  const rows = db.prepare(
    `SELECT cp.* FROM content_publications cp
      WHERE cp.artifact_id IN (${PROJECT_ARTIFACT_IDS_SQL})${cursorClause}
      ORDER BY cp.artifact_kind, cp.artifact_id
      LIMIT ?`,
  ).all(...params, pageSize) as Record<string, unknown>[];

  const nextCursor = rows.length < pageSize
    ? null
    : JSON.stringify([rows[rows.length - 1].artifact_kind, rows[rows.length - 1].artifact_id]);
  return { rows: rows.map((r) => sanitizeSyncPayload('content_publications', r)), nextCursor };
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
