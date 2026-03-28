/**
 * Team outbox CRUD query helpers.
 *
 * The outbox pattern: write paths enqueue records here when team sync is enabled.
 * The sync client flushes pending records in batches to the Cloudflare Worker.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { isTeamSyncEnabled, getTeamMachineId } from '@myco/daemon/team-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max records returned per listPending call. */
const BURST_BATCH_SIZE = 200;

/** Age in seconds after which sent records are pruned (24 hours). */
const SENT_PRUNE_AGE_SECONDS = 86_400;

/** Milliseconds-per-second multiplier for epoch math. */
const MS_PER_SECOND = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when enqueuing an outbox record. */
export interface OutboxInsert {
  table_name: string;
  row_id: string;
  operation?: string;
  payload: string;
  machine_id: string;
  created_at: number;
}

/** Row shape returned from outbox queries. */
export interface OutboxRow {
  id: number;
  table_name: string;
  row_id: string;
  operation: string;
  payload: string;
  machine_id: string;
  created_at: number;
  sent_at: number | null;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const OUTBOX_COLUMNS = [
  'id',
  'table_name',
  'row_id',
  'operation',
  'payload',
  'machine_id',
  'created_at',
  'sent_at',
] as const;

const SELECT_COLUMNS = OUTBOX_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed OutboxRow. */
function toOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: row.id as number,
    table_name: row.table_name as string,
    row_id: row.row_id as string,
    operation: row.operation as string,
    payload: row.payload as string,
    machine_id: row.machine_id as string,
    created_at: row.created_at as number,
    sent_at: (row.sent_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Convenience helper — used by query modules
// ---------------------------------------------------------------------------

/**
 * Enqueue a row for team sync if sync is enabled.
 *
 * Centralizes the if-enabled / enqueue / serialize pattern that every
 * write-path query module previously duplicated inline.
 */
export function syncRow(tableName: string, row: { id: string | number; created_at?: number }): void {
  if (!isTeamSyncEnabled()) return;
  enqueueOutbox({
    table_name: tableName,
    row_id: String(row.id),
    payload: JSON.stringify(row),
    machine_id: getTeamMachineId(),
    created_at: row.created_at ?? Math.floor(Date.now() / 1000),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a record into the team outbox for later sync.
 *
 * Inserted with `sent_at = NULL` (pending).
 */
export function enqueueOutbox(data: OutboxInsert): OutboxRow {
  const db = getDatabase();

  const info = db.prepare(
    `INSERT INTO team_outbox (
       table_name, row_id, operation, payload, machine_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    data.table_name,
    data.row_id,
    data.operation ?? 'upsert',
    data.payload,
    data.machine_id,
    data.created_at,
  );

  const id = Number(info.lastInsertRowid);

  return toOutboxRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM team_outbox WHERE id = ?`).get(id) as Record<string, unknown>,
  );
}

/**
 * List pending outbox records (oldest-first).
 *
 * Uses burst sizing: fetches BURST_BATCH_SIZE rows and returns them all.
 * If fewer than BURST_THRESHOLD rows come back, callers get a normal-size
 * batch; if more, the full burst. This avoids a separate COUNT query.
 */
export function listPending(limit?: number): OutboxRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM team_outbox
     WHERE sent_at IS NULL
     ORDER BY created_at ASC
     LIMIT ?`,
  ).all(limit ?? BURST_BATCH_SIZE) as Record<string, unknown>[];

  return rows.map(toOutboxRow);
}

/**
 * Mark outbox records as sent by setting sent_at.
 */
export function markSent(ids: number[], sentAt: number): void {
  if (ids.length === 0) return;

  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(', ');

  db.prepare(
    `UPDATE team_outbox
     SET sent_at = ?
     WHERE id IN (${placeholders})`,
  ).run(sentAt, ...ids);
}

/**
 * Reset sent_at to NULL for records that need to be retried.
 *
 * This allows the sync client to re-enqueue specific records for retry.
 */
export function markForRetry(ids: number[]): void {
  if (ids.length === 0) return;

  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(', ');

  db.prepare(
    `UPDATE team_outbox
     SET sent_at = NULL
     WHERE id IN (${placeholders})`,
  ).run(...ids);
}

/**
 * Prune old outbox records.
 *
 * Removes sent records older than 24 hours.
 *
 * @returns the number of records deleted.
 */
export function pruneOld(): number {
  const db = getDatabase();
  const cutoff = Math.floor(Date.now() / MS_PER_SECOND) - SENT_PRUNE_AGE_SECONDS;

  const info = db.prepare(
    `DELETE FROM team_outbox
     WHERE sent_at IS NOT NULL AND sent_at < ?`,
  ).run(cutoff);

  return info.changes;
}

/**
 * Count pending (unsent) outbox records.
 */
export function countPending(): number {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM team_outbox WHERE sent_at IS NULL`,
  ).get() as { count: number };

  return row.count;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

/** Tables to backfill (must have id, machine_id, synced_at columns). */
const BACKFILL_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
] as const;
// entity_mentions excluded — no `id` column (composite key entity_id+note_id+note_type)

/**
 * Enqueue all unsynced records across all synced tables into the outbox.
 *
 * Scans each table for rows where `synced_at IS NULL`, serializes the full
 * row as JSON, and inserts into the outbox. Idempotent — re-running only
 * picks up rows not yet in the outbox (checked via existing outbox entries).
 *
 * @returns the total number of records enqueued.
 */
export function backfillUnsynced(machineId: string): number {
  const db = getDatabase();
  let total = 0;

  const now = Math.floor(Date.now() / MS_PER_SECOND);

  const runBackfill = db.transaction(() => {
    for (const table of BACKFILL_TABLES) {
      // Get rows that haven't been synced and aren't already in the outbox
      const rows = db.prepare(
        `SELECT * FROM ${table}
         WHERE synced_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM team_outbox
           WHERE team_outbox.table_name = ? AND team_outbox.row_id = CAST(${table}.id AS TEXT)
         )`,
      ).all(table) as Record<string, unknown>[];

      if (rows.length === 0) continue;

      const stmt = db.prepare(
        `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
         VALUES (?, ?, 'upsert', ?, ?, ?)`,
      );

      for (const row of rows) {
        stmt.run(table, String(row.id), JSON.stringify(row), machineId, now);
        total++;
      }
    }
  });

  runBackfill();
  return total;
}

