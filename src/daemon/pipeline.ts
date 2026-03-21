/**
 * PipelineManager — SQLite-backed pipeline state for work item tracking,
 * stage transitions, and circuit breakers.
 *
 * Follows the same database pattern as MycoIndex (src/index/sqlite.ts):
 * better-sqlite3, WAL mode, CREATE IF NOT EXISTS for idempotency.
 */

import Database from 'better-sqlite3';
import path from 'node:path';
import type { PipelineStage, PipelineStatus, PipelineProviderRole } from '@myco/constants';
import {
  PIPELINE_STAGES,
  ITEM_STAGE_MAP,
  PIPELINE_TRANSIENT_MAX_RETRIES,
  PIPELINE_PARSE_MAX_RETRIES,
  PIPELINE_BACKOFF_BASE_MS,
  PIPELINE_BACKOFF_MULTIPLIER,
  PIPELINE_CIRCUIT_FAILURE_THRESHOLD,
  PIPELINE_CIRCUIT_COOLDOWN_MS,
  PIPELINE_RETENTION_DAYS,
  STAGE_PROVIDER_MAP,
} from '@myco/constants';

/** Database filename within the vault directory. */
const PIPELINE_DB_FILENAME = 'pipeline.db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CircuitState {
  provider_role: string;
  state: 'closed' | 'open' | 'half-open';
  failure_count: number;
  last_failure: string | null;
  last_error: string | null;
  opens_at: string | null;
  updated_at: string;
}

export interface PipelineHealth {
  stages: Record<string, Record<string, number>>;
  circuits: Array<{
    provider_role: string;
    state: string;
    failure_count: number;
    last_error: string | null;
  }>;
  totals: {
    pending: number;
    processing: number;
    failed: number;
    blocked: number;
    poisoned: number;
    succeeded: number;
  };
}

export interface AdvanceOptions {
  errorType?: 'transient' | 'config' | 'parse';
  errorMessage?: string;
}

export interface StageStatus {
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface BatchItem {
  id: string;
  item_type: string;
  source_path: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Schema SQL
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
  -- work_items: every piece of content in the pipeline
  CREATE TABLE IF NOT EXISTS work_items (
    id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    source_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (id, item_type)
  );

  -- stage_transitions: append-only audit trail
  CREATE TABLE IF NOT EXISTS stage_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    status TEXT NOT NULL,
    attempt INTEGER DEFAULT 1,
    error_type TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (work_item_id, item_type) REFERENCES work_items(id, item_type)
  );

  -- stage_history: compacted transitions older than retention window
  CREATE TABLE IF NOT EXISTS stage_history (
    work_item_id TEXT NOT NULL,
    item_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    total_attempts INTEGER,
    final_status TEXT NOT NULL,
    first_attempt TEXT NOT NULL,
    last_attempt TEXT NOT NULL,
    last_error TEXT,
    error_types TEXT,
    PRIMARY KEY (work_item_id, item_type, stage)
  );

  -- circuit_breakers: per-provider-role state
  CREATE TABLE IF NOT EXISTS circuit_breakers (
    provider_role TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'closed',
    failure_count INTEGER DEFAULT 0,
    last_failure TEXT,
    last_error TEXT,
    opens_at TEXT,
    updated_at TEXT NOT NULL
  );
`;

const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_transitions_item_stage
    ON stage_transitions(work_item_id, item_type, stage);
  CREATE INDEX IF NOT EXISTS idx_transitions_status
    ON stage_transitions(status);
  CREATE INDEX IF NOT EXISTS idx_items_type
    ON work_items(item_type);
`;

const VIEW_SQL = `
  CREATE VIEW IF NOT EXISTS pipeline_status AS
  WITH ranked AS (
    SELECT st.*,
      ROW_NUMBER() OVER (
        PARTITION BY st.work_item_id, st.item_type, st.stage
        ORDER BY st.id DESC
      ) AS rn
    FROM stage_transitions st
  )
  SELECT
    wi.id, wi.item_type, wi.source_path,
    r.stage, r.status, r.attempt,
    r.error_type, r.error_message,
    r.started_at, r.completed_at
  FROM work_items wi
  JOIN ranked r ON r.work_item_id = wi.id AND r.item_type = wi.item_type
  WHERE r.rn = 1;
`;

// ---------------------------------------------------------------------------
// Health query SQL
// ---------------------------------------------------------------------------

/** Aggregate counts of stage x status from the pipeline_status view. */
const HEALTH_STAGE_STATUS_SQL = `
  SELECT stage, status, COUNT(*) as count
  FROM pipeline_status
  GROUP BY stage, status
`;

/** All circuit breaker rows. */
const HEALTH_CIRCUITS_SQL = `
  SELECT provider_role, state, failure_count, last_error
  FROM circuit_breakers
`;

// ---------------------------------------------------------------------------
// PipelineManager
// ---------------------------------------------------------------------------

export class PipelineManager {
  private db: Database.Database;

  constructor(vaultDir: string) {
    const dbPath = path.join(vaultDir, PIPELINE_DB_FILENAME);
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  private init(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(INDEXES_SQL);
    this.db.exec(VIEW_SQL);
  }

  /** Expose the underlying database for direct queries (used in tests and by higher-level methods). */
  getDb(): Database.Database {
    return this.db;
  }

  /** Read a PRAGMA value (used in tests to verify WAL mode and foreign keys). */
  getPragma(name: string): unknown {
    return this.db.pragma(name, { simple: true });
  }

  /** Aggregate pipeline health: stage/status counts, circuit states, totals. */
  health(): PipelineHealth {
    const stageRows = this.db.prepare(HEALTH_STAGE_STATUS_SQL).all() as Array<{
      stage: string;
      status: string;
      count: number;
    }>;

    const stages: Record<string, Record<string, number>> = {};
    const totals: PipelineHealth['totals'] = {
      pending: 0,
      processing: 0,
      failed: 0,
      blocked: 0,
      poisoned: 0,
      succeeded: 0,
    };

    for (const row of stageRows) {
      if (!stages[row.stage]) {
        stages[row.stage] = {};
      }
      stages[row.stage][row.status] = row.count;

      // Accumulate into totals if the status is one we track
      if (row.status in totals) {
        totals[row.status as keyof typeof totals] += row.count;
      }
    }

    const circuitRows = this.db.prepare(HEALTH_CIRCUITS_SQL).all() as Array<{
      provider_role: string;
      state: string;
      failure_count: number;
      last_error: string | null;
    }>;

    const circuits = circuitRows.map((r) => ({
      provider_role: r.provider_role,
      state: r.state,
      failure_count: r.failure_count,
      last_error: r.last_error,
    }));

    return { stages, circuits, totals };
  }

  // -------------------------------------------------------------------------
  // Work item registration
  // -------------------------------------------------------------------------

  /**
   * Register a work item in the pipeline. Creates the work_items row and
   * initial stage_transitions for all applicable stages.
   *
   * Uses INSERT OR IGNORE for work_items (idempotency — re-registering is a no-op).
   * Checks if transitions already exist before inserting.
   */
  register(itemId: string, itemType: string, sourcePath?: string): void {
    const now = new Date().toISOString();

    // INSERT OR IGNORE — idempotent for the work_items row
    this.db
      .prepare(
        'INSERT OR IGNORE INTO work_items (id, item_type, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(itemId, itemType, sourcePath ?? null, now, now);

    // Check if transitions already exist (idempotency guard)
    const existingCount = this.db
      .prepare(
        'SELECT COUNT(*) as cnt FROM stage_transitions WHERE work_item_id = ? AND item_type = ?',
      )
      .get(itemId, itemType) as { cnt: number };

    if (existingCount.cnt > 0) {
      return; // Already registered — skip transition creation
    }

    const applicableStages = ITEM_STAGE_MAP[itemType] ?? [];
    const insertStmt = this.db.prepare(
      'INSERT INTO stage_transitions (work_item_id, item_type, stage, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const insertAll = this.db.transaction(() => {
      for (const stage of PIPELINE_STAGES) {
        const status = applicableStages.includes(stage) ? 'pending' : 'skipped';
        insertStmt.run(itemId, itemType, stage, status, 1, now);
      }
    });
    insertAll();
  }

  // -------------------------------------------------------------------------
  // Stage transitions
  // -------------------------------------------------------------------------

  /**
   * Record a stage transition. Append-only — never updates existing rows.
   *
   * When status is 'failed': checks retry limits and may auto-poison.
   * When error_type is 'config': blocks all downstream stages.
   */
  advance(
    itemId: string,
    itemType: string,
    stage: string,
    status: string,
    error?: AdvanceOptions,
  ): void {
    const now = new Date().toISOString();

    // Calculate attempt by counting prior transitions with 'failed' or 'processing' status
    const priorCount = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM stage_transitions
         WHERE work_item_id = ? AND item_type = ? AND stage = ?
         AND status IN ('failed', 'processing')`,
      )
      .get(itemId, itemType, stage) as { cnt: number };

    const attempt = status === 'failed' || status === 'processing'
      ? Math.ceil((priorCount.cnt + 1) / 2) || 1
      : priorCount.cnt > 0
        ? Math.ceil(priorCount.cnt / 2) || 1
        : 1;

    let resolvedStatus = status;

    // Check for auto-poison on failure
    if (status === 'failed' && error?.errorType) {
      const maxRetries =
        error.errorType === 'transient'
          ? PIPELINE_TRANSIENT_MAX_RETRIES
          : PIPELINE_PARSE_MAX_RETRIES;

      // Count prior failed transitions for this item+stage
      const failedCount = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM stage_transitions
           WHERE work_item_id = ? AND item_type = ? AND stage = ? AND status = 'failed'`,
        )
        .get(itemId, itemType, stage) as { cnt: number };

      if (failedCount.cnt >= maxRetries) {
        resolvedStatus = 'poisoned';
      }
    }

    // Set started_at for processing, completed_at for terminal states
    const startedAt = status === 'processing' ? now : null;
    const completedAt = ['succeeded', 'failed', 'poisoned', 'blocked', 'skipped'].includes(resolvedStatus) ? now : null;

    this.db
      .prepare(
        `INSERT INTO stage_transitions
         (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        itemId,
        itemType,
        stage,
        resolvedStatus,
        attempt,
        error?.errorType ?? null,
        error?.errorMessage ?? null,
        startedAt,
        completedAt,
        now,
      );

    // Update work_items.updated_at
    this.db
      .prepare('UPDATE work_items SET updated_at = ? WHERE id = ? AND item_type = ?')
      .run(now, itemId, itemType);

    // Block downstream stages when error_type is 'config'
    if (status === 'failed' && error?.errorType === 'config') {
      const stageIdx = PIPELINE_STAGES.indexOf(stage as PipelineStage);
      if (stageIdx >= 0) {
        const downstreamStages = PIPELINE_STAGES.slice(stageIdx + 1);
        for (const downstream of downstreamStages) {
          // Only block stages that are currently pending (not already skipped)
          const currentStatus = this.db
            .prepare(
              `SELECT status FROM stage_transitions
               WHERE work_item_id = ? AND item_type = ? AND stage = ?
               ORDER BY id DESC LIMIT 1`,
            )
            .get(itemId, itemType, downstream) as { status: string } | undefined;

          if (currentStatus && currentStatus.status === 'pending') {
            this.db
              .prepare(
                `INSERT INTO stage_transitions
                 (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
                 VALUES (?, ?, ?, 'blocked', 1, 'config', ?, NULL, ?, ?)`,
              )
              .run(
                itemId,
                itemType,
                downstream,
                `blocked by ${stage} config failure`,
                now,
                now,
              );
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Status queries
  // -------------------------------------------------------------------------

  /**
   * Get current status for all stages of a work item.
   * Queries the pipeline_status view filtered by work_item_id and item_type.
   */
  getItemStatus(itemId: string, itemType: string): StageStatus[] {
    return this.db
      .prepare(
        `SELECT stage, status, attempt, error_type, error_message, started_at, completed_at
         FROM pipeline_status
         WHERE id = ? AND item_type = ?`,
      )
      .all(itemId, itemType) as StageStatus[];
  }

  // -------------------------------------------------------------------------
  // Batch queries
  // -------------------------------------------------------------------------

  /**
   * Get pending work items ready for processing at a given stage.
   *
   * Requirements:
   * - Only items where the requested stage is 'pending'
   * - Only items whose PREVIOUS stage (in PIPELINE_STAGES order) is 'succeeded' or 'skipped'
   * - Exclude items in backoff window
   * - Ordered by work_items.created_at ASC (oldest first)
   */
  nextBatch(stage: string, limit: number): BatchItem[] {
    const stageIdx = PIPELINE_STAGES.indexOf(stage as PipelineStage);

    // For the first stage (capture), there is no upstream requirement
    if (stageIdx === 0) {
      return this.db
        .prepare(
          `SELECT ps.id, ps.item_type, ps.source_path, wi.created_at
           FROM pipeline_status ps
           JOIN work_items wi ON wi.id = ps.id AND wi.item_type = ps.item_type
           WHERE ps.stage = ? AND ps.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM stage_transitions st2
             WHERE st2.work_item_id = ps.id AND st2.item_type = ps.item_type
             AND st2.stage = ? AND st2.status = 'failed'
             AND st2.completed_at IS NOT NULL
             AND (julianday('now') - julianday(st2.completed_at)) * 86400000 <
               ? * POWER(?, (
                 SELECT COUNT(*) FROM stage_transitions st3
                 WHERE st3.work_item_id = ps.id AND st3.item_type = ps.item_type
                 AND st3.stage = ? AND st3.status = 'failed'
               ) - 1)
           )
           ORDER BY wi.created_at ASC
           LIMIT ?`,
        )
        .all(
          stage,
          stage,
          PIPELINE_BACKOFF_BASE_MS,
          PIPELINE_BACKOFF_MULTIPLIER,
          stage,
          limit,
        ) as BatchItem[];
    }

    const prevStage = PIPELINE_STAGES[stageIdx - 1];

    return this.db
      .prepare(
        `SELECT ps.id, ps.item_type, ps.source_path, wi.created_at
         FROM pipeline_status ps
         JOIN work_items wi ON wi.id = ps.id AND wi.item_type = ps.item_type
         WHERE ps.stage = ? AND ps.status = 'pending'
         AND EXISTS (
           SELECT 1 FROM pipeline_status ps2
           WHERE ps2.id = ps.id AND ps2.item_type = ps.item_type
           AND ps2.stage = ? AND ps2.status IN ('succeeded', 'skipped')
         )
         AND NOT EXISTS (
           SELECT 1 FROM stage_transitions st2
           WHERE st2.work_item_id = ps.id AND st2.item_type = ps.item_type
           AND st2.stage = ? AND st2.status = 'failed'
           AND st2.completed_at IS NOT NULL
           AND (julianday('now') - julianday(st2.completed_at)) * 86400000 <
             ? * POWER(?, (
               SELECT COUNT(*) FROM stage_transitions st3
               WHERE st3.work_item_id = ps.id AND st3.item_type = ps.item_type
               AND st3.stage = ? AND st3.status = 'failed'
             ) - 1)
         )
         ORDER BY wi.created_at ASC
         LIMIT ?`,
      )
      .all(
        stage,
        prevStage,
        stage,
        PIPELINE_BACKOFF_BASE_MS,
        PIPELINE_BACKOFF_MULTIPLIER,
        stage,
        limit,
      ) as BatchItem[];
  }

  // -------------------------------------------------------------------------
  // Circuit breakers
  // -------------------------------------------------------------------------

  /**
   * Get current state of a circuit breaker for the given provider role.
   * Returns the persisted row, or a synthetic default (closed, 0 failures)
   * if no row exists yet.
   */
  circuitState(providerRole: string): CircuitState {
    const row = this.db
      .prepare('SELECT * FROM circuit_breakers WHERE provider_role = ?')
      .get(providerRole) as CircuitState | undefined;

    if (row) {
      return row;
    }

    // Return a synthetic default — do not persist until first trip
    return {
      provider_role: providerRole,
      state: 'closed',
      failure_count: 0,
      last_failure: null,
      last_error: null,
      opens_at: null,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Record a failure against a circuit breaker. Increments failure_count and
   * updates last_error / last_failure. If failure_count reaches
   * PIPELINE_CIRCUIT_FAILURE_THRESHOLD, sets state to 'open' and calculates
   * opens_at = now + PIPELINE_CIRCUIT_COOLDOWN_MS.
   */
  tripCircuit(providerRole: string, errorMessage: string): void {
    const now = new Date().toISOString();
    const current = this.circuitState(providerRole);
    const newFailureCount = current.failure_count + 1;

    const shouldOpen = newFailureCount >= PIPELINE_CIRCUIT_FAILURE_THRESHOLD;
    const newState = shouldOpen ? 'open' : 'closed';
    const opensAt = shouldOpen
      ? new Date(Date.now() + PIPELINE_CIRCUIT_COOLDOWN_MS).toISOString()
      : null;

    this.db
      .prepare(
        `INSERT INTO circuit_breakers
           (provider_role, state, failure_count, last_failure, last_error, opens_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_role) DO UPDATE SET
           state        = excluded.state,
           failure_count = excluded.failure_count,
           last_failure  = excluded.last_failure,
           last_error    = excluded.last_error,
           opens_at      = excluded.opens_at,
           updated_at    = excluded.updated_at`,
      )
      .run(providerRole, newState, newFailureCount, now, errorMessage, opensAt, now);
  }

  /**
   * Manually reset a circuit breaker to closed state.
   * Sets state='closed', failure_count=0, clears opens_at.
   */
  resetCircuit(providerRole: string): void {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO circuit_breakers
           (provider_role, state, failure_count, last_failure, last_error, opens_at, updated_at)
         VALUES (?, 'closed', 0, NULL, NULL, NULL, ?)
         ON CONFLICT(provider_role) DO UPDATE SET
           state         = 'closed',
           failure_count = 0,
           opens_at      = NULL,
           updated_at    = excluded.updated_at`,
      )
      .run(providerRole, now);
  }

  /**
   * Check if an open circuit's cooldown has expired and is ready for a
   * half-open probe. If state is 'open' and current time >= opens_at,
   * transitions state to 'half-open' and returns true. Otherwise returns false.
   */
  probeCircuit(providerRole: string): boolean {
    const current = this.circuitState(providerRole);

    if (current.state !== 'open') {
      return false;
    }

    if (!current.opens_at) {
      return false;
    }

    const now = Date.now();
    const opensAt = new Date(current.opens_at).getTime();

    if (now < opensAt) {
      return false;
    }

    // Cooldown has expired — transition to half-open
    this.db
      .prepare(
        `UPDATE circuit_breakers
         SET state = 'half-open', updated_at = ?
         WHERE provider_role = ?`,
      )
      .run(new Date().toISOString(), providerRole);

    return true;
  }

  /**
   * When a circuit opens, find all stages that use this provider role and
   * insert new 'blocked' transitions for all items that currently have
   * 'pending' status at those stages.
   *
   * Returns the count of blocked items.
   */
  blockItemsForCircuit(providerRole: string): number {
    const affectedStages = (Object.keys(STAGE_PROVIDER_MAP) as Array<keyof typeof STAGE_PROVIDER_MAP>)
      .filter((stage) => STAGE_PROVIDER_MAP[stage] === providerRole);

    if (affectedStages.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    let blockedCount = 0;

    const insertBlocked = this.db.transaction(() => {
      for (const stage of affectedStages) {
        // Find all items currently pending at this stage
        const pendingItems = this.db
          .prepare(
            `SELECT id, item_type FROM pipeline_status
             WHERE stage = ? AND status = 'pending'`,
          )
          .all(stage) as Array<{ id: string; item_type: string }>;

        for (const item of pendingItems) {
          this.db
            .prepare(
              `INSERT INTO stage_transitions
               (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
               VALUES (?, ?, ?, 'blocked', 1, 'config', ?, NULL, ?, ?)`,
            )
            .run(
              item.id,
              item.item_type,
              stage,
              `circuit open: ${providerRole}`,
              now,
              now,
            );

          blockedCount++;
        }
      }
    });

    insertBlocked();
    return blockedCount;
  }

  /**
   * When a circuit closes, find all stages that use this provider role and
   * insert new 'pending' transitions for all items that currently have
   * 'blocked' status at those stages.
   *
   * Returns the count of unblocked items.
   */
  unblockItemsForCircuit(providerRole: string): number {
    const affectedStages = (Object.keys(STAGE_PROVIDER_MAP) as Array<keyof typeof STAGE_PROVIDER_MAP>)
      .filter((stage) => STAGE_PROVIDER_MAP[stage] === providerRole);

    if (affectedStages.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    let unblockedCount = 0;

    const insertPending = this.db.transaction(() => {
      for (const stage of affectedStages) {
        // Find all items currently blocked at this stage
        const blockedItems = this.db
          .prepare(
            `SELECT id, item_type FROM pipeline_status
             WHERE stage = ? AND status = 'blocked'`,
          )
          .all(stage) as Array<{ id: string; item_type: string }>;

        for (const item of blockedItems) {
          this.db
            .prepare(
              `INSERT INTO stage_transitions
               (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
               VALUES (?, ?, ?, 'pending', 1, NULL, NULL, NULL, NULL, ?)`,
            )
            .run(item.id, item.item_type, stage, now);

          unblockedCount++;
        }
      }
    });

    insertPending();
    return unblockedCount;
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  /**
   * Compact stage_transitions older than retentionDays into stage_history rows.
   *
   * For each (work_item_id, item_type, stage) group whose transitions are older
   * than the cutoff, inserts or replaces a stage_history row aggregating those
   * transitions, then deletes the original rows.
   *
   * Returns `{ compacted, deleted }`: compacted = number of groups written to
   * stage_history; deleted = number of transition rows removed.
   */
  compact(retentionDays: number = PIPELINE_RETENTION_DAYS): { compacted: number; deleted: number } {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    // Find all old transition rows, grouped by (work_item_id, item_type, stage).
    // We need the aggregate values per group as well as every individual error_type
    // so we can build the error_types JSON. Fetch the raw rows and aggregate in JS.
    const oldRows = this.db
      .prepare(
        `SELECT id, work_item_id, item_type, stage, status, attempt, error_type, created_at
         FROM stage_transitions
         WHERE created_at < ?
         ORDER BY id ASC`,
      )
      .all(cutoff) as Array<{
        id: number;
        work_item_id: string;
        item_type: string;
        stage: string;
        status: string;
        attempt: number;
        error_type: string | null;
        created_at: string;
      }>;

    if (oldRows.length === 0) {
      return { compacted: 0, deleted: 0 };
    }

    // Group rows by (work_item_id, item_type, stage)
    const groups = new Map<
      string,
      {
        work_item_id: string;
        item_type: string;
        stage: string;
        rows: typeof oldRows;
      }
    >();

    for (const row of oldRows) {
      const key = `${row.work_item_id}\0${row.item_type}\0${row.stage}`;
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(key, { work_item_id: row.work_item_id, item_type: row.item_type, stage: row.stage, rows: [row] });
      }
    }

    const upsertHistory = this.db.prepare(
      `INSERT OR REPLACE INTO stage_history
         (work_item_id, item_type, stage, total_attempts, final_status, first_attempt, last_attempt, last_error, error_types)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const deleteTransitions = this.db.prepare(
      'DELETE FROM stage_transitions WHERE work_item_id = ? AND item_type = ? AND stage = ? AND created_at < ?',
    );

    let compacted = 0;
    let deleted = 0;

    const doCompact = this.db.transaction(() => {
      for (const group of groups.values()) {
        // Rows are ordered by id ASC; the last row is the latest
        const latestRow = group.rows[group.rows.length - 1];
        const earliestRow = group.rows[0];

        // Count error_types
        const errorTypeCounts: Record<string, number> = {};
        for (const row of group.rows) {
          if (row.error_type) {
            errorTypeCounts[row.error_type] = (errorTypeCounts[row.error_type] ?? 0) + 1;
          }
        }

        // Fetch last_error for the latest transition in the group
        const lastErrorRow = this.db
          .prepare(
            `SELECT error_message FROM stage_transitions
             WHERE work_item_id = ? AND item_type = ? AND stage = ?
             ORDER BY id DESC LIMIT 1`,
          )
          .get(group.work_item_id, group.item_type, group.stage) as { error_message: string | null } | undefined;

        upsertHistory.run(
          group.work_item_id,
          group.item_type,
          group.stage,
          group.rows.length,
          latestRow.status,
          earliestRow.created_at,
          latestRow.created_at,
          lastErrorRow?.error_message ?? null,
          JSON.stringify(errorTypeCounts),
        );

        const deleteResult = deleteTransitions.run(
          group.work_item_id,
          group.item_type,
          group.stage,
          cutoff,
        );

        compacted++;
        deleted += deleteResult.changes;
      }
    });

    doCompact();
    return { compacted, deleted };
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Recover stuck items on daemon startup.
   *
   * Finds all items currently in 'processing' status (via the pipeline_status view)
   * and inserts a new 'pending' transition for each, effectively resetting them
   * for reprocessing.
   *
   * Returns the count of recovered items.
   */
  recoverStuck(): number {
    const now = new Date().toISOString();

    // Find all item/stage pairs currently stuck in 'processing'
    const stuckItems = this.db
      .prepare(
        `SELECT id, item_type, stage FROM pipeline_status WHERE status = 'processing'`,
      )
      .all() as Array<{ id: string; item_type: string; stage: string }>;

    if (stuckItems.length === 0) {
      return 0;
    }

    const insertPending = this.db.prepare(
      `INSERT INTO stage_transitions
         (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
       VALUES (?, ?, ?, 'pending', 1, NULL, NULL, NULL, NULL, ?)`,
    );

    const doRecover = this.db.transaction(() => {
      for (const item of stuckItems) {
        insertPending.run(item.id, item.item_type, item.stage, now);
      }
    });

    doRecover();
    return stuckItems.length;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
