/**
 * Team outbox CRUD query helpers.
 *
 * The outbox is a thin local buffer for the daemon → team Worker hop.
 * Cloudflare Queues handle retries, exponential backoff, and dead-lettering
 * once a record reaches the worker; the outbox just remembers what we still
 * need to hand off when the Worker is reachable.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { isTeamSyncEnabled, getTeamMachineId } from '@myco/daemon/team-context.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max records returned per listPending call. Cloudflare Queues sendBatch caps at 100. */
const BURST_BATCH_SIZE = 100;

/** Age in seconds after which sent records are pruned (24 hours). */
const SENT_PRUNE_AGE_SECONDS = 86_400;

/** Milliseconds-per-second multiplier for epoch math. */
const MS_PER_SECOND = 1000;

/**
 * Tables that are intentionally *local-only* and must never be enqueued for
 * team sync. Attempting to enqueue one of these is a programming error and
 * throws so the bug surfaces at the call site instead of silently syncing
 * private state to the team.
 *
 * Add future local-only tables here (e.g. transient operational caches,
 * per-machine skill lookup indexes) alongside a comment describing why the
 * table is local-only.
 */
export const LOCAL_ONLY_OUTBOX_TABLES = new Set<string>([
  // Cortex instructions: per-machine operating guidance generated from local
  // digest substrate. Removed from team sync at schema v19. See
  // migrateV18ToV19 for the corresponding safety-net DELETE.
  'cortex_instructions',
  // Raw release provenance carries branch names, changed paths, and local Git
  // evidence. Only the derived knowledge_release_state rows are team-safe.
  'knowledge_git_provenance',
]);

export const LOCAL_ONLY_SYNC_COLUMNS: Record<string, readonly string[]> = {
  sessions: [
    'embedded',
    'canopy_injections_offered',
    'canopy_injection_total_tokens',
    'canopy_skips_after_injection',
    'canopy_reads_after_injection',
    'canopy_tokens_saved',
    'canopy_redundant_reads',
    'canopy_map_tool_calls',
  ],
  knowledge_release_state: [
    // basis_ref can be a local branch name (e.g., `feat/secret-name`) and
    // basis_sha pinpoints an internal commit. Neither belongs in team sync
    // per release-provenance plan §R13.
    'basis_ref',
    'basis_sha',
    'evidence_json',
  ],
};

/**
 * Human-readable rationale for each local-only table/column group. The Team
 * page UI surfaces this so operators can see why their data isn't
 * appearing on a teammate's machine. Co-located with the policy itself so
 * the disclosure can't drift from the enforcement.
 */
export const LOCAL_ONLY_RATIONALES: Record<string, string> = {
  cortex_instructions: 'Per-machine operating guidance generated from local digest substrate; never synced to the team.',
  knowledge_git_provenance: 'Raw local Git provenance can include branch names, changed paths, and patch evidence; only derived release state syncs.',
  sessions: 'Local-only behavioural counters: embedding state and Canopy injection telemetry stay on the originating machine.',
  knowledge_release_state: 'Derived release state syncs, but local branch names, commit SHAs, and evidence summaries stay on the originating machine.',
};

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

/**
 * Row shape returned from outbox queries.
 *
 * `payload` is the parsed JSON object — `toOutboxRow` parses on read so
 * consumers don't have to remember to. The persisted storage column is
 * still TEXT (JSON-encoded); only the in-memory shape is structured.
 */
export interface OutboxRow {
  id: number;
  table_name: string;
  row_id: string;
  operation: string;
  payload: Record<string, unknown>;
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

/** Normalize a SQLite result row into a typed OutboxRow. Parses the JSON
 *  payload column once so consumers operate on the structured shape. */
function toOutboxRow(row: Record<string, unknown>): OutboxRow {
  const rawPayload = row.payload;
  let payload: Record<string, unknown>;
  try {
    payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload as Record<string, unknown>);
  } catch {
    // Persisted payload is corrupt — surface the raw string under a known
    // key so downstream code can still log + discard rather than crashing.
    payload = { __raw: rawPayload };
  }
  return {
    id: row.id as number,
    table_name: row.table_name as string,
    row_id: row.row_id as string,
    operation: row.operation as string,
    payload,
    machine_id: row.machine_id as string,
    created_at: row.created_at as number,
    sent_at: (row.sent_at as number) ?? null,
  };
}

export function sanitizeSyncPayload(
  tableName: string,
  row: object,
): Record<string, unknown> {
  const payload = { ...(row as Record<string, unknown>) };
  for (const column of LOCAL_ONLY_SYNC_COLUMNS[tableName] ?? []) {
    delete payload[column];
  }
  return payload;
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
export function syncRow(
  tableName: string,
  row: object & { id: string | number; created_at?: number },
): void {
  if (!isTeamSyncEnabled()) return;
  enqueueOutbox({
    table_name: tableName,
    row_id: String(row.id),
    payload: JSON.stringify(sanitizeSyncPayload(tableName, row)),
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
 * Inserted with `sent_at = NULL` (pending). Rejects attempts to enqueue
 * tables listed in `LOCAL_ONLY_OUTBOX_TABLES` so private per-machine data
 * can never leak into team sync via a stray call site.
 */
export function enqueueOutbox(data: OutboxInsert): OutboxRow {
  if (LOCAL_ONLY_OUTBOX_TABLES.has(data.table_name)) {
    throw new Error(
      `enqueueOutbox: table '${data.table_name}' is local-only and must not be synced`,
    );
  }

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

/** List pending outbox records (oldest-first). */
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

/** Mark outbox records as sent by setting sent_at. */
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
 * Discard outbox rows that the worker rejected at validation time
 * (e.g. unknown table). These will never succeed; retrying them is
 * pointless and they would otherwise grow the buffer indefinitely.
 */
export function discardRows(ids: number[]): void {
  if (ids.length === 0) return;

  const db = getDatabase();
  const placeholders = ids.map(() => '?').join(', ');

  db.prepare(
    `DELETE FROM team_outbox WHERE id IN (${placeholders})`,
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

/** Count pending (unsent) outbox records. */
export function countPending(): number {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM team_outbox WHERE sent_at IS NULL`,
  ).get() as { count: number };

  return row.count;
}

// ---------------------------------------------------------------------------
// Source-row sync bookkeeping
// ---------------------------------------------------------------------------

/** Tables eligible for backfill/sync (must have id, machine_id, synced_at columns). */
export const TEAM_SYNC_BACKFILL_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'skill_candidates',
  'skill_records',
  'knowledge_release_state',
] as const;
// entity_mentions excluded — no `id` column (composite key entity_id+note_id+note_type)
// skill_usage excluded — no `synced_at` column (syncs via syncRow on insert)

export const TEAM_SYNC_OBSERVED_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'skill_candidates',
  'skill_records',
  'skill_usage',
  'knowledge_release_state',
] as const;

export type TeamSyncObservedTable = (typeof TEAM_SYNC_OBSERVED_TABLES)[number];

const BACKFILL_TABLE_SET = new Set<string>(TEAM_SYNC_BACKFILL_TABLES);

export function countTeamSyncRows(): Record<TeamSyncObservedTable, number> {
  const db = getDatabase();
  const counts = {} as Record<TeamSyncObservedTable, number>;
  for (const table of TEAM_SYNC_OBSERVED_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

/**
 * Mark source rows as synced after successful outbox flush.
 *
 * Groups outbox records by table_name, then sets `synced_at` on the
 * corresponding source rows. This closes the re-enqueue loop: once
 * synced_at is non-NULL, `backfillUnsynced` skips the row even after
 * the outbox entry is pruned.
 *
 * Note: with queues, `synced_at` records that the daemon handed the row
 * off to the worker — not that the queue consumer wrote it to D1. A
 * record that ends up in the DLQ will still show synced_at on the local
 * side; the DLQ surface (PR2) is where operators see and resolve those.
 */
export function markSourceRowsSynced(records: OutboxRow[], syncedAt: number): void {
  const db = getDatabase();

  // Group row_ids by table
  const byTable = new Map<string, string[]>();
  for (const rec of records) {
    if (!BACKFILL_TABLE_SET.has(rec.table_name)) continue;
    const ids = byTable.get(rec.table_name) ?? [];
    ids.push(rec.row_id);
    byTable.set(rec.table_name, ids);
  }

  for (const [table, ids] of byTable) {
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(
      `UPDATE ${table} SET synced_at = ? WHERE id IN (${placeholders}) AND synced_at IS NULL`,
    ).run(syncedAt, ...ids);
  }
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

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
  return backfillRows(machineId, 'unsynced');
}

/**
 * Enqueue every sync-eligible Grove row into the outbox, even if the row was
 * previously handed to the Worker. This is the operator reconciliation path:
 * useful after provisioning a fresh team Worker, repairing remote state, or
 * validating that the full Grove can be resent idempotently.
 */
export function backfillAll(machineId: string): number {
  return backfillRows(machineId, 'all');
}

function backfillRows(machineId: string, mode: 'unsynced' | 'all'): number {
  const db = getDatabase();
  let total = 0;

  const now = Math.floor(Date.now() / MS_PER_SECOND);

  // Process one table at a time in separate transactions to avoid long locks
  for (const table of TEAM_SYNC_BACKFILL_TABLES) {
    const sourcePredicate = mode === 'unsynced' ? 'synced_at IS NULL' : '1 = 1';
    const outboxPredicate = mode === 'unsynced' ? '' : 'AND team_outbox.sent_at IS NULL';
    const rows = db.prepare(
      `SELECT * FROM ${table}
       WHERE ${sourcePredicate}
       AND NOT EXISTS (
         SELECT 1 FROM team_outbox
         WHERE team_outbox.table_name = ? AND team_outbox.row_id = CAST(${table}.id AS TEXT)
         ${outboxPredicate}
       )`,
    ).all(table) as Record<string, unknown>[];

    if (rows.length === 0) continue;

    const insertBatch = db.transaction((batchRows: Record<string, unknown>[]) => {
      const stmt = db.prepare(
        `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
         VALUES (?, ?, 'upsert', ?, ?, ?)`,
      );
      for (const row of batchRows) {
        // Strip local-only columns before serializing — backfill must follow
        // the same contract as syncRow(), or restart-driven re-enqueues will
        // ship columns the worker D1 has no place for.
        stmt.run(table, String(row.id), JSON.stringify(sanitizeSyncPayload(table, row)), machineId, now);
      }
    });

    insertBatch(rows);
    total += rows.length;
  }

  return total;
}
