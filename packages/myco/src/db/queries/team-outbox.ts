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
import { TEAM_SYNC_OBSERVED_TABLES, type TeamSyncObservedTable } from '@myco/db/schema-ddl.js';
import { getSyncableProjectTeamId } from '@myco/db/queries/team-sync-state.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max records returned per listPending call. Cloudflare Queues sendBatch caps at 100. */
const BURST_BATCH_SIZE = 100;

/** Age in seconds after which sent records are pruned (24 hours). */
const SENT_PRUNE_AGE_SECONDS = 86_400;

/**
 * SQL `LIKE` allowlist for activity rows that represent a Myco tool call.
 *
 * Shared by:
 *   - `aggregateSessionMycoToolCalls` in `db/queries/myco-tool-usage.ts`
 *     (per-session aggregator run at Stop boundary)
 *   - `migrateV44ToV45` in `db/migrations.ts` (one-time backfill of the
 *     new `session_myco_tool_calls` table)
 *
 * Kept in one place so the two consumers can't drift on what counts as a
 * "Myco tool call" — adding a new prefix here lights it up for both. The
 * embedded backslash escapes match SQLite's `ESCAPE '\'` clause used at
 * both call sites.
 */
export const MYCO_TOOL_LIKE_PATTERNS: readonly string[] = Object.freeze([
  'myco\\_%',
  'mcp__myco__myco\\_%',
  'collective\\_%',
  'mcp__myco__collective\\_%',
]);

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
  // Per-session Myco tool-call counts (added schema v45). Same class of data
  // as the Canopy behavioural counters on `sessions` already listed in
  // LOCAL_ONLY_SYNC_COLUMNS: it's local agent-behavioural telemetry derived
  // from `activities` (which itself does not sync). The value lives in the
  // local session-detail tile; cross-machine rollups are not a use case.
  'session_myco_tool_calls',
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
  session_myco_tool_calls: 'Per-session Myco tool-call telemetry, derived locally from activities; same class as the Canopy behavioural counters on sessions and stays on the originating machine.',
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
  team_id?: string | null;
  project_id?: string | null;
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
  team_id: string | null;
  project_id: string | null;
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
  'team_id',
  'project_id',
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
    team_id: (row.team_id as string) ?? null,
    project_id: (row.project_id as string) ?? null,
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
  const projectId = (row as { project_id?: string }).project_id ?? null;
  // Project-scoped tenancy gate: a row syncs iff its project is an explicit
  // team member. (Machine-scoped self-rows never flow through syncRow — they are
  // enqueued by the daemon's reconcileSelfMember / backfill paths.) Membership
  // is only populated when the grove participates, so this subsumes the prior
  // grove-level getTeamSyncEnabled check.
  const teamId = getSyncableProjectTeamId(projectId);
  if (!teamId) return;
  enqueueOutbox({
    table_name: tableName,
    row_id: String(row.id),
    payload: JSON.stringify(sanitizeSyncPayload(tableName, row)),
    machine_id: getTeamMachineId(),
    team_id: teamId,
    project_id: projectId,
    created_at: row.created_at ?? epochSeconds(),
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
  const teamId = data.team_id !== undefined
    ? data.team_id
    : getSyncableProjectTeamId(data.project_id ?? null, db);

  const info = db.prepare(
    `INSERT INTO team_outbox (
       table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.table_name,
    data.row_id,
    data.operation ?? 'upsert',
    data.payload,
    data.machine_id,
    teamId ?? null,
    data.project_id ?? null,
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

/**
 * List pending outbox records for a single project (oldest-first). The
 * residency drain (`host/residency-drain.ts`) ships one project's queued rows
 * to its Team Host; the global {@link listPending} would interleave other
 * projects' rows. Reuses the same pending predicate and row shape.
 */
export function listPendingForProject(projectId: string, limit?: number): OutboxRow[] {
  const db = getDatabase();
  // The residency backfill enqueues every table under ONE shared timestamp, so
  // created_at alone leaves equal-timestamp order unspecified by SQLite. The
  // autoincrement `id` tiebreak preserves enqueue order, and the backfill
  // enqueues in FK-topological table order (parents before children) — so a
  // child never ships before its parent within a tick, which would otherwise
  // wedge the give-up-on-409 drain (parent never re-ordered ahead).
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM team_outbox
     WHERE sent_at IS NULL AND project_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  ).all(projectId, limit ?? BURST_BATCH_SIZE) as Record<string, unknown>[];

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
  const cutoff = epochSeconds() - SENT_PRUNE_AGE_SECONDS;

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

/**
 * Count pending (unsent) outbox rows whose project routes to the given set.
 * Used for the team-scoped Status/Sync pending number. Machine-scoped rows
 * (null project_id, e.g. team_members) are excluded — they are not
 * project-attributable and fan out to all participating teams.
 */
export function countPendingForProjects(projectIds: string[]): number {
  if (projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => '?').join(', ');
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM team_outbox
      WHERE sent_at IS NULL AND project_id IN (${placeholders})`,
  ).get(...projectIds) as { count: number };
  return row.count;
}

/**
 * Drop pending (unsent) outbox rows for the given projects. Returns the count
 * removed. Used when a teammate forgets a joined team so its queued rows don't
 * linger or get lazily dropped on the next drain.
 */
export function dropPendingForProjects(projectIds: string[]): number {
  if (projectIds.length === 0) return 0;
  const db = getDatabase();
  const placeholders = projectIds.map(() => '?').join(', ');
  const result = db.prepare(
    `DELETE FROM team_outbox
      WHERE sent_at IS NULL
        AND operation <> 'delete'
        AND project_id IN (${placeholders})`,
  ).run(...projectIds);
  return result.changes;
}

/**
 * Delete stale pending outbox rows for project-scoped UPSERTs whose project is
 * not in the given member set. DELETE tombstones are intentionally preserved:
 * they carry the project row's original team_id and must be allowed to route
 * after de-membership so the cloud copy is removed. Non-delete rows carrying a
 * team_id that is no longer registered are dropped because there is no client to
 * route them to.
 */
export function purgeNonMemberOutbox(memberProjectIds: string[], validTeamIds?: string[]): number {
  const db = getDatabase();
  let removed = 0;
  if (memberProjectIds.length === 0) {
    removed += db.prepare(
      `DELETE FROM team_outbox
        WHERE sent_at IS NULL
          AND project_id IS NOT NULL
          AND operation <> 'delete'`,
    ).run().changes;
  } else {
    const placeholders = memberProjectIds.map(() => '?').join(', ');
    removed += db.prepare(
      `DELETE FROM team_outbox
        WHERE sent_at IS NULL
          AND project_id IS NOT NULL
          AND operation <> 'delete'
          AND project_id NOT IN (${placeholders})`,
    ).run(...memberProjectIds).changes;
  }
  if (validTeamIds === undefined) {
    return removed;
  }
  if (validTeamIds.length === 0) {
    removed += db.prepare(
      `DELETE FROM team_outbox
        WHERE sent_at IS NULL
          AND team_id IS NOT NULL
          AND operation <> 'delete'`,
    ).run().changes;
  } else {
    const teamPlaceholders = validTeamIds.map(() => '?').join(', ');
    removed += db.prepare(
      `DELETE FROM team_outbox
        WHERE sent_at IS NULL
          AND team_id IS NOT NULL
          AND operation <> 'delete'
          AND team_id NOT IN (${teamPlaceholders})`,
    ).run(...validTeamIds).changes;
  }
  return removed;
}

export function countPendingDeleteTombstonesForTeam(teamId: string): number {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) AS count
       FROM team_outbox
      WHERE sent_at IS NULL
        AND operation = 'delete'
        AND team_id = ?`,
  ).get(teamId) as { count: number };
  return row.count;
}

/**
 * Per-table breakdown of pending (unsent) outbox records. Used by the
 * disable-time purge so the daemon can log what's being dropped without
 * the operator having to query SQLite themselves.
 */
export function countPendingByTable(): Record<string, number> {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT table_name, COUNT(*) as count
       FROM team_outbox
      WHERE sent_at IS NULL
      GROUP BY table_name`,
  ).all() as Array<{ table_name: string; count: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) out[row.table_name] = row.count;
  return out;
}

/**
 * Insert pre-selected source rows into `team_outbox` as `'upsert'` records.
 *
 * Shared write contract used by `backfillRows` (startup unsynced sweep and
 * operator rebuild). Centralizes the `INSERT INTO team_outbox` SQL, the
 * `sanitizeSyncPayload` call, and the single-table transaction wrapping so
 * callers can't drift on the payload shape.
 */
export function insertOutboxRowsForUpsert(
  db: ReturnType<typeof getDatabase>,
  tableName: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  machineId: string,
  now: number,
): void {
  if (rows.length === 0) return;
  db.transaction((batchRows: ReadonlyArray<Record<string, unknown>>) => {
    const stmt = db.prepare(
      `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at)
       VALUES (?, ?, 'upsert', ?, ?, ?, ?, ?)`,
    );
    for (const row of batchRows) {
      // Carry project_id from the source row exactly as `syncRow` does, so
      // re-enqueued (backfilled/rebuilt) rows route to the right team's
      // worker. Machine-scoped rows (e.g. team_members) have no project_id
      // and resolve to null — correct for fan-out routing.
      const projectId = (row as { project_id?: string }).project_id ?? null;
      const teamId = (row.__myco_team_id as string | undefined) ?? null;
      const payloadRow = { ...row };
      delete payloadRow.__myco_team_id;
      stmt.run(
        tableName,
        String(row.id),
        JSON.stringify(sanitizeSyncPayload(tableName, payloadRow)),
        machineId,
        teamId,
        projectId,
        now,
      );
    }
  })(rows);
}

/**
 * Drop pending (unsent) outbox rows. Used when team sync is disabled —
 * either explicitly via the disconnect handler, or by the daemon startup
 * sweep for vaults whose `team.enabled = false` setting has left orphan
 * rows behind.
 *
 * Only `sent_at IS NULL` rows are removed. Successfully-sent rows are
 * retained for retention pruning to handle on its own cadence.
 *
 * Returns the number of rows removed so the caller can log the operation.
 * The corresponding source records (sessions, spores, etc.) are untouched —
 * if team sync is re-enabled later, `handleBackfill` re-enqueues from
 * current state. Stale outbox rows would carry months-old snapshots, so
 * dropping them is the correct behavior, not data loss.
 */
export function purgePendingOutbox(): number {
  const db = getDatabase();
  const info = db.prepare(
    `DELETE FROM team_outbox WHERE sent_at IS NULL`,
  ).run();
  return info.changes;
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
  'skill_lineage',
  'knowledge_release_state',
  'team_members',
  'okf_generations',
  'okf_pages',
  'okf_page_revisions',
] as const;
// entity_mentions excluded — no `id` column (composite key entity_id+note_id+note_type)
// skill_usage excluded — no `synced_at` column (syncs via syncRow on insert); included
// in REBUILD_TABLES so rebuild produces an exact cloud mirror

/**
 * Tables eligible for a full rebuild re-push. A superset of TEAM_SYNC_BACKFILL_TABLES
 * that includes skill_usage: the worker's /rebuild truncates skill_usage (it is in
 * SYNCED_TABLES on the worker), so after a rebuild D1's skill_usage stays empty unless
 * we re-push it here. skill_usage has id + machine_id but no synced_at column, which
 * means it cannot be included in TEAM_SYNC_BACKFILL_TABLES (backfillUnsynced's
 * `synced_at IS NULL` predicate would error). The 'all' mode used by
 * backfillAllForRebuild uses `1 = 1` as its source predicate and only guards via the
 * outbox NOT-EXISTS check (team_outbox.sent_at IS NULL), so it is safe for tables
 * without synced_at.
 *
 * Do NOT add skill_usage to TEAM_SYNC_BACKFILL_TABLES — it would break backfillUnsynced.
 */
export const REBUILD_TABLES = [...TEAM_SYNC_BACKFILL_TABLES, 'skill_usage'] as const;

/**
 * Tables eligible for symmetric reconcile (the daemon's project-partition diff
 * against the worker's GET /manifest). Mirrors the worker-side
 * MANIFEST_ELIGIBLE_TABLES (`src/worker/src/manifest.ts`) — the synced set minus
 * the id-less `entity_mentions` — further restricted to PROJECT-scoped tables.
 *
 * Reconcile runs strictly per (machine_id, project_id) partition, so the
 * machine-scoped `team_members` table (no `project_id` column; maintained via
 * reconcileSelfMember + backfill) is excluded — interpolating it into the
 * project-scoped partition query would reference a non-existent column.
 *
 * Only these names may be interpolated into the reconcile path's table-name SQL
 * (`localPartition`, `buildUpsertPayload`); the allow-list is the SQL-injection
 * safety boundary — never pass an arbitrary table name into that path.
 */
export const RECONCILE_ELIGIBLE_TABLES: readonly string[] = REBUILD_TABLES.filter(
  (t) => t !== 'team_members',
);

// Canonical synced/observed set now lives in the dependency-free schema-ddl
// module (so the migration chain can import it without pulling db/client →
// bun:sqlite into the worker-CLI bundle). Imported above for internal use and
// re-exported here for existing consumers that import it from this module.
export { TEAM_SYNC_OBSERVED_TABLES };
export type { TeamSyncObservedTable };

const BACKFILL_TABLE_SET = new Set<string>(TEAM_SYNC_BACKFILL_TABLES);

export interface ProjectRemovalTombstoneResult {
  enqueued: number;
  reset: number;
}

/**
 * Enqueue carried-team delete tombstones for every local project-scoped row
 * before a project is removed from team membership. The source rows stay local,
 * but `synced_at` is reset so re-adding the project later re-pushes them through
 * the normal unsynced backfill path.
 */
export function enqueueProjectRemovalTombstones(opts: {
  projectId: string;
  teamId: string;
  machineId: string;
  createdAt?: number;
}): ProjectRemovalTombstoneResult {
  const db = getDatabase();
  const createdAt = opts.createdAt ?? epochSeconds();
  let enqueued = 0;
  let reset = 0;

  db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, team_id, project_id, created_at)
       VALUES (?, ?, 'delete', ?, ?, ?, ?, ?)`,
    );

    for (const table of RECONCILE_ELIGIBLE_TABLES) {
      const rows = db.prepare(
        `SELECT id, machine_id
           FROM ${table}
          WHERE project_id = ? AND machine_id = ?`,
      ).all(opts.projectId, opts.machineId) as Array<{ id: string | number; machine_id: string }>;

      for (const row of rows) {
        insert.run(
          table,
          String(row.id),
          JSON.stringify({ id: row.id, machine_id: row.machine_id }),
          row.machine_id,
          opts.teamId,
          opts.projectId,
          createdAt,
        );
      }
      enqueued += rows.length;

      if (BACKFILL_TABLE_SET.has(table)) {
        reset += db.prepare(
          `UPDATE ${table}
              SET synced_at = NULL
            WHERE project_id = ? AND machine_id = ?`,
        ).run(opts.projectId, opts.machineId).changes;
      }
    }
  })();

  return { enqueued, reset };
}

export function countTeamSyncRows(
  machineId?: string,
  projectIds?: readonly string[],
): Record<TeamSyncObservedTable, number> {
  const db = getDatabase();
  const counts = {} as Record<TeamSyncObservedTable, number>;
  const projectScoped = projectIds !== undefined;
  const projectPlaceholders = projectIds?.map(() => '?').join(', ') ?? '';
  for (const table of TEAM_SYNC_OBSERVED_TABLES) {
    if (projectScoped && (projectIds.length === 0 || table === 'team_members')) {
      counts[table] = 0;
      continue;
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (machineId) {
      conditions.push('machine_id = ?');
      params.push(machineId);
    }
    if (projectScoped) {
      conditions.push(`project_id IN (${projectPlaceholders})`);
      params.push(...projectIds);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get(...params) as { count: number };
    counts[table] = row.count;
  }
  return counts;
}

/**
 * Mark upsert source rows as synced after successful outbox flush.
 *
 * Groups upsert outbox records by table_name, then sets `synced_at` on the
 * corresponding source rows. This closes the re-enqueue loop: once
 * synced_at is non-NULL, `backfillUnsynced` skips the row even after
 * the outbox entry is pruned.
 *
 * Delete tombstones are delivery records, not source-row sync events; marking
 * their source rows would corrupt re-add semantics after a project leaves and
 * later rejoins a team.
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
    if (rec.operation !== 'upsert') continue;
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

/**
 * Re-enqueue every row across the full REBUILD_TABLES set (a superset of
 * TEAM_SYNC_BACKFILL_TABLES that includes skill_usage). Called by
 * rebuildFromLocal after the worker's /rebuild truncates the cloud mirror.
 *
 * Must use 'all' mode — skill_usage has no synced_at column, so 'unsynced'
 * mode's `synced_at IS NULL` predicate would error on it.
 */
export function backfillAllForRebuild(machineId: string, teamId?: string): number {
  return backfillRows(machineId, 'all', REBUILD_TABLES, { teamId });
}

export function backfillProjectForTeam(machineId: string, projectId: string, teamId: string): number {
  return backfillRows(machineId, 'all', REBUILD_TABLES, {
    includeMachineScoped: false,
    projectId,
    teamId,
  });
}

// ---------------------------------------------------------------------------
// Reconcile helpers (symmetric reconcile)
// ---------------------------------------------------------------------------

/**
 * A minimal row shape for partition comparisons.
 * `content_hash` is present only for tables that carry the column
 * (sessions, prompt_batches, spores, plans).
 */
export interface PartitionRow {
  id: string;
  content_hash?: string;
}

/**
 * Return all local rows for a (machineId, projectId, table) partition in the
 * minimal `{ id, content_hash? }` shape needed by diffPartition.
 *
 * Always uses `1=1` as the row predicate (the reconcile path needs the full
 * local id-set, not just unsynced rows). Tables that lack a `synced_at`
 * column — specifically skill_usage — are safe here because no
 * `synced_at IS NULL` predicate is applied.
 *
 * `content_hash` is included in the SELECT only when the table's schema
 * carries that column (detected via PRAGMA table_info). For presence-only
 * tables the returned rows have no `content_hash` property so diffPartition
 * skips stale detection automatically.
 */
export function localPartition(
  machineId: string,
  projectId: string,
  table: string,
): PartitionRow[] {
  const db = getDatabase();

  // Detect available columns for this table via the schema.
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((r) => r.name),
  );

  const selectCols = cols.has('content_hash') ? 'id, content_hash' : 'id';

  const rows = db.prepare(
    `SELECT ${selectCols}
     FROM ${table}
     WHERE machine_id = ? AND project_id = ?`,
  ).all(machineId, projectId) as Array<{ id: string; content_hash?: string }>;

  return rows.map((r) => {
    const row: PartitionRow = { id: String(r.id) };
    if (cols.has('content_hash') && r.content_hash != null) {
      row.content_hash = r.content_hash;
    }
    return row;
  });
}

/**
 * Return the set of row_ids in team_outbox that are still pending
 * (`sent_at IS NULL`) for the exact (table, machine_id, project_id) partition.
 *
 * Used by the reconcile orchestrator to skip rows already in-flight so the
 * outbox is not double-enqueued before the pending entries drain.
 */
export function pendingRowIdsForPartition(
  table: string,
  machineId: string,
  projectId: string,
): Set<string> {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT row_id
     FROM team_outbox
     WHERE table_name = ?
       AND machine_id = ?
       AND project_id = ?
       AND sent_at IS NULL`,
  ).all(table, machineId, projectId) as Array<{ row_id: string }>;

  return new Set(rows.map((r) => r.row_id));
}

function backfillRows(
  machineId: string,
  mode: 'unsynced' | 'all',
  tables: readonly string[] = TEAM_SYNC_BACKFILL_TABLES,
  opts: { includeMachineScoped?: boolean; projectId?: string; teamId?: string } = {},
): number {
  const db = getDatabase();
  let total = 0;
  const now = epochSeconds();

  // Process one table at a time in separate transactions to avoid long locks.
  // INSERT happens via the shared `insertOutboxRowsForUpsert` helper so the
  // sanitization contract stays in one place.
  for (const table of tables) {
    // 'all' mode is the rebuild path (backfillAllForRebuild → /api/team/rebuild).
    // rebuildFromLocal calls client.rebuild() — which truncates THIS machine's
    // cloud rows — *before* re-enqueuing. So every local row must produce a
    // post-truncate outbox entry, unconditionally. We deliberately omit the
    // NOT EXISTS skip here: skipping a row that happens to have a pending
    // (sent_at IS NULL) outbox entry — e.g. because a routine flush is mid-drain
    // when the rebuild fires — would delete it from cloud yet never re-enqueue
    // it, losing the row from D1 until an unrelated future edit. A duplicate
    // pending entry is safe: the worker upsert is keyed by the composite PK
    // (id, machine_id) and is idempotent, so the row simply pushes twice.
    //
    // 'unsynced' mode (routine startup sweep) dedups against PENDING outbox
    // entries only (sent_at IS NULL). A SENT-but-unpruned entry (retained
    // 24h for diagnostics) must not mask an unsynced row: drop-path resets
    // and JOIN-second-team both leave rows with synced_at NULL whose only
    // outbox trace is a sent entry — deduping against those left the row
    // absent from D1 (while the UI showed 0 pending) until the prune
    // window expired. Re-enqueuing beside a sent entry is safe for the
    // same reason 'all' mode tolerates duplicates: the worker upsert is
    // keyed by composite PK and idempotent.
    // Project-scoped tenancy gate: exclude rows whose project is not a team
    // member. The machine-scoped team_members self-row table has no project_id
    // and is exempt — it must always backfill so the roster reaches the outbox.
    const isMachineScoped = table === 'team_members';
    if (isMachineScoped && opts.includeMachineScoped === false) continue;
    const sourceExpr = isMachineScoped
      ? `${table}.*, NULL AS __myco_team_id FROM ${table}`
      : `${table}.*, team_sync_membership.team_id AS __myco_team_id FROM ${table}
           INNER JOIN team_sync_membership ON team_sync_membership.project_id = ${table}.project_id`;
    const filters: string[] = [];
    const filterParams: unknown[] = [];
    if (!isMachineScoped && opts.teamId) {
      filters.push('team_sync_membership.team_id = ?');
      filterParams.push(opts.teamId);
    }
    if (!isMachineScoped && opts.projectId) {
      filters.push(`${table}.project_id = ?`);
      filterParams.push(opts.projectId);
    }
    const filterSql = filters.length > 0 ? ` AND ${filters.join(' AND ')}` : '';
    const rows = mode === 'all'
      ? db.prepare(`SELECT ${sourceExpr} WHERE 1=1${filterSql}`).all(...filterParams) as Record<string, unknown>[]
      : db.prepare(
          `SELECT ${sourceExpr}
           WHERE synced_at IS NULL${filterSql}
           AND NOT EXISTS (
             SELECT 1 FROM team_outbox
             WHERE team_outbox.table_name = ? AND team_outbox.row_id = CAST(${table}.id AS TEXT)
               AND team_outbox.sent_at IS NULL
           )`,
        ).all(...filterParams, table) as Record<string, unknown>[];

    if (rows.length === 0) continue;
    insertOutboxRowsForUpsert(db, table, rows, machineId, now);
    total += rows.length;
  }

  return total;
}
