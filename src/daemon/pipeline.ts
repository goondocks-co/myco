/**
 * PipelineManager — SQLite-backed pipeline state for work item tracking,
 * stage transitions, and circuit breakers.
 *
 * Follows the same database pattern as MycoIndex (src/index/sqlite.ts):
 * better-sqlite3, WAL mode, CREATE IF NOT EXISTS for idempotency.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { PipelineStage, PipelineStatus, PipelineProviderRole } from '@myco/constants';
import {
  PIPELINE_STAGES,
  PIPELINE_TICK_STAGES,
  ITEM_STAGE_MAP,
  PIPELINE_TRANSIENT_MAX_RETRIES,
  PIPELINE_PARSE_MAX_RETRIES,
  PIPELINE_BACKOFF_BASE_MS,
  PIPELINE_BACKOFF_MULTIPLIER,
  PIPELINE_CIRCUIT_FAILURE_THRESHOLD,
  PIPELINE_CIRCUIT_COOLDOWN_MS,
  PIPELINE_RETENTION_DAYS,
  PIPELINE_ITEMS_DEFAULT_LIMIT,
  STAGE_PROVIDER_MAP,
} from '@myco/constants';
import { classifyError } from '@myco/daemon/pipeline-classify';

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

export interface PipelineItem {
  id: string;
  item_type: string;
  source_path: string | null;
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TransitionRecord {
  id: number;
  work_item_id: string;
  item_type: string;
  stage: string;
  status: string;
  attempt: number;
  error_type: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface RebuildResult {
  registered: number;
  stages: Record<string, number>;
}

/** Minimal interface for vector index lookups during rebuild. */
export interface VectorHasCheck {
  has(id: string): boolean;
}

// ---------------------------------------------------------------------------
// Stage handlers interface
// ---------------------------------------------------------------------------

/**
 * Handlers called by tick() for each processable stage.
 * Digest is NOT here — it's gated by the metabolism timer, not the pipeline tick.
 */
export interface StageHandlers {
  extraction: (itemId: string, itemType: string, sourcePath: string | null) => Promise<void>;
  embedding: (itemId: string, itemType: string, sourcePath: string | null) => Promise<void>;
  consolidation: (itemId: string, itemType: string, sourcePath: string | null) => Promise<void>;
}

/** Optional logger for tick() diagnostics. */
export type TickLogger = (level: string, domain: string, message: string, data?: Record<string, unknown>) => void;

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

  // -------------------------------------------------------------------------
  // API query helpers
  // -------------------------------------------------------------------------

  /**
   * List work items from the pipeline_status view with optional filters and pagination.
   *
   * Filters: stage, status, item_type. All optional.
   * Returns rows ordered by work_items.created_at DESC (newest first).
   */
  listItems(filters: {
    stage?: string;
    status?: string;
    type?: string;
    limit?: number;
    offset?: number;
  }): { items: PipelineItem[]; total: number } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.stage) {
      conditions.push('ps.stage = ?');
      params.push(filters.stage);
    }
    if (filters.status) {
      conditions.push('ps.status = ?');
      params.push(filters.status);
    }
    if (filters.type) {
      conditions.push('ps.item_type = ?');
      params.push(filters.type);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countSql = `SELECT COUNT(*) as total FROM pipeline_status ps ${where}`;
    const countRow = this.db.prepare(countSql).get(...params) as { total: number };

    const limit = filters.limit ?? PIPELINE_ITEMS_DEFAULT_LIMIT;
    const offset = filters.offset ?? 0;

    const querySql = `
      SELECT ps.id, ps.item_type, ps.source_path, ps.stage, ps.status,
             ps.attempt, ps.error_type, ps.error_message, ps.started_at, ps.completed_at
      FROM pipeline_status ps
      JOIN work_items wi ON wi.id = ps.id AND wi.item_type = ps.item_type
      ${where}
      ORDER BY wi.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const items = this.db.prepare(querySql).all(...params, limit, offset) as PipelineItem[];

    return { items, total: countRow.total };
  }

  /**
   * Get the full transition history for a single work item.
   * Returns all stage_transitions rows ordered by id ASC (oldest first).
   */
  getTransitionHistory(itemId: string, itemType: string): TransitionRecord[] {
    return this.db
      .prepare(
        `SELECT id, work_item_id, item_type, stage, status, attempt,
                error_type, error_message, started_at, completed_at, created_at
         FROM stage_transitions
         WHERE work_item_id = ? AND item_type = ?
         ORDER BY id ASC`,
      )
      .all(itemId, itemType) as TransitionRecord[];
  }

  /**
   * Retry a single poisoned work item by inserting a new 'pending' transition
   * at the specified stage. Returns true if the item was poisoned and retried,
   * false if the item was not found or not poisoned at that stage.
   */
  retryItem(itemId: string, itemType: string, stage: string): boolean {
    // Verify the item is actually poisoned at this stage
    const current = this.db
      .prepare(
        `SELECT status FROM pipeline_status
         WHERE id = ? AND item_type = ? AND stage = ?`,
      )
      .get(itemId, itemType, stage) as { status: string } | undefined;

    if (!current || current.status !== 'poisoned') {
      return false;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO stage_transitions
           (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
         VALUES (?, ?, ?, 'pending', 1, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(itemId, itemType, stage, now);

    return true;
  }

  /**
   * Retry all poisoned items by inserting new 'pending' transitions.
   * Returns the count of items retried.
   */
  retryAllPoisoned(): number {
    const poisonedItems = this.db
      .prepare(
        `SELECT id, item_type, stage FROM pipeline_status WHERE status = 'poisoned'`,
      )
      .all() as Array<{ id: string; item_type: string; stage: string }>;

    if (poisonedItems.length === 0) {
      return 0;
    }

    const now = new Date().toISOString();
    const insertPending = this.db.prepare(
      `INSERT INTO stage_transitions
         (work_item_id, item_type, stage, status, attempt, error_type, error_message, started_at, completed_at, created_at)
       VALUES (?, ?, ?, 'pending', 1, NULL, NULL, NULL, NULL, ?)`,
    );

    const doRetry = this.db.transaction(() => {
      for (const item of poisonedItems) {
        insertPending.run(item.id, item.item_type, item.stage, now);
      }
    });

    doRetry();
    return poisonedItems.length;
  }

  /**
   * List all circuit breaker rows from the database.
   */
  listCircuits(): CircuitState[] {
    return this.db
      .prepare('SELECT * FROM circuit_breakers ORDER BY provider_role ASC')
      .all() as CircuitState[];
  }

  // -------------------------------------------------------------------------
  // Tick processing
  // -------------------------------------------------------------------------

  private handlers: StageHandlers | null = null;
  private tickInProgress = false;
  private tickLogger: TickLogger | null = null;

  /** Register stage handlers called by tick(). Must be set before tick() is useful. */
  setHandlers(handlers: StageHandlers): void {
    this.handlers = handlers;
  }

  /** Set a logger for tick diagnostics. */
  setLogger(logger: TickLogger): void {
    this.tickLogger = logger;
  }

  /**
   * Process one tick of the pipeline: for each tick-processable stage
   * (extraction, embedding, consolidation), fetch a batch of pending items
   * and run the corresponding handler.
   *
   * Stages are processed sequentially; items within a batch run concurrently.
   *
   * Guarded by tickInProgress — if a tick is already running, returns immediately.
   */
  async tick(batchSize: number): Promise<void> {
    if (this.tickInProgress) {
      return;
    }

    if (!this.handlers) {
      return;
    }

    this.tickInProgress = true;
    try {
      for (const stage of PIPELINE_TICK_STAGES) {
        const providerRole = STAGE_PROVIDER_MAP[stage];

        // Check circuit breaker state for this stage's provider
        if (providerRole) {
          const circuit = this.circuitState(providerRole);

          if (circuit.state === 'open') {
            // Check if cooldown expired — allow a half-open probe
            const canProbe = this.probeCircuit(providerRole);
            if (!canProbe) {
              // Circuit still open, ensure items are blocked
              const blocked = this.blockItemsForCircuit(providerRole);
              if (blocked > 0) {
                this.tickLogger?.('debug', 'pipeline', `Circuit open for ${providerRole}, blocked ${blocked} items`, { stage, providerRole });
              }
              continue;
            }
            // Half-open: fall through to process one item as probe
            this.tickLogger?.('debug', 'pipeline', `Circuit half-open probe for ${providerRole}`, { stage, providerRole });
          }
        }

        const batch = this.nextBatch(stage, batchSize);
        if (batch.length === 0) {
          continue;
        }

        const handler = this.handlers[stage as keyof StageHandlers];
        if (!handler) {
          continue;
        }

        // Process batch items concurrently
        await Promise.all(
          batch.map(async (item) => {
            // Advance to processing
            this.advance(item.id, item.item_type, stage, 'processing');

            try {
              await handler(item.id, item.item_type, item.source_path);
              // Handler succeeded
              this.advance(item.id, item.item_type, stage, 'succeeded');

              // If circuit was half-open and probe succeeded, reset it
              if (providerRole) {
                const circuitAfter = this.circuitState(providerRole);
                if (circuitAfter.state === 'half-open') {
                  this.resetCircuit(providerRole);
                  const unblocked = this.unblockItemsForCircuit(providerRole);
                  this.tickLogger?.('info', 'pipeline', `Circuit closed after successful probe, unblocked ${unblocked} items`, { stage, providerRole });
                }
              }
            } catch (err) {
              const error = err instanceof Error ? err : new Error(String(err));
              const classified = classifyError(error);

              this.advance(item.id, item.item_type, stage, 'failed', {
                errorType: classified.type,
                errorMessage: error.message,
              });

              this.tickLogger?.('warn', 'pipeline', `Stage handler failed: ${stage}`, {
                itemId: item.id,
                itemType: item.item_type,
                errorType: classified.type,
                error: error.message,
              });

              // Trip circuit breaker on config errors
              if (classified.type === 'config' && providerRole) {
                this.tripCircuit(providerRole, error.message);
                const circuit = this.circuitState(providerRole);
                if (circuit.state === 'open') {
                  const blocked = this.blockItemsForCircuit(providerRole);
                  this.tickLogger?.('warn', 'pipeline', `Circuit opened for ${providerRole}, blocked ${blocked} items`, { stage, providerRole });
                }
              }
            }
          }),
        );
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  // -------------------------------------------------------------------------
  // Digest gating helpers
  // -------------------------------------------------------------------------

  /**
   * Check if any upstream stages (extraction, embedding, consolidation) have
   * active work items (pending, processing, or blocked — but not failed/poisoned).
   *
   * Used to gate the digest engine: digest should not run while upstream
   * stages still have work in flight.
   */
  hasUpstreamWork(): boolean {
    for (const stage of PIPELINE_TICK_STAGES) {
      const count = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM pipeline_status
           WHERE stage = ? AND status IN ('pending', 'processing', 'blocked')`,
        )
        .get(stage) as { cnt: number };
      if (count.cnt > 0) return true;
    }
    return false;
  }

  /**
   * Mark all digest:pending items as digest:succeeded after a successful cycle.
   * Returns the number of items advanced.
   */
  advanceDigestItems(): number {
    const items = this.db
      .prepare(
        `SELECT id, item_type FROM pipeline_status
         WHERE stage = 'digest' AND status = 'pending'`,
      )
      .all() as Array<{ id: string; item_type: string }>;

    for (const item of items) {
      this.advance(item.id, item.item_type, 'digest', 'succeeded');
    }
    return items.length;
  }

  // -------------------------------------------------------------------------
  // Rebuild from vault
  // -------------------------------------------------------------------------

  /**
   * Walk the vault and infer pipeline stage completion from existing data.
   *
   * Used for first-run migration: when pipeline.db is empty but the vault
   * already has session, spore, and artifact files from prior processing.
   *
   * Algorithm:
   * 1. Walk sessions/, spores/, artifacts/ directories for .md files
   * 2. Register each as a work item with inferred stage statuses
   * 3. Check vector index for embedding status
   * 4. Check digest trace for digest status
   * 5. Infer extraction status for sessions (check if spores reference them)
   * 6. Mark spore consolidation as pending (cannot reliably infer)
   */
  rebuild(
    vaultDir: string,
    vectorIndex: VectorHasCheck | null,
    digestTracePath?: string,
  ): RebuildResult {
    const digestedIds = this.loadDigestedIds(digestTracePath);
    const sporeSessionIds = this.collectSporeSessionIds(vaultDir);
    const stages: Record<string, number> = {};
    let registered = 0;

    const bumpStage = (key: string): void => {
      stages[key] = (stages[key] ?? 0) + 1;
    };

    // --- Sessions ---
    const sessionsDir = path.join(vaultDir, 'sessions');
    for (const filePath of this.walkMarkdownFiles(sessionsDir)) {
      const filename = path.basename(filePath, '.md');
      // session-<id>.md → id = everything after "session-"
      const itemId = filename.startsWith('session-') ? filename.slice('session-'.length) : filename;
      const relativePath = path.relative(vaultDir, filePath);

      this.register(itemId, 'session', relativePath);
      registered++;

      // capture: file exists → succeeded
      this.advance(itemId, 'session', 'capture', 'succeeded');
      bumpStage('capture:succeeded');

      // extraction: check if any spore references this session
      if (sporeSessionIds.has(itemId) || sporeSessionIds.has(`session-${itemId}`)) {
        this.advance(itemId, 'session', 'extraction', 'succeeded');
        bumpStage('extraction:succeeded');
      } else {
        bumpStage('extraction:pending');
      }

      // embedding: check vector index
      if (vectorIndex?.has(itemId) || vectorIndex?.has(`session-${itemId}`)) {
        this.advance(itemId, 'session', 'embedding', 'succeeded');
        bumpStage('embedding:succeeded');
      } else {
        bumpStage('embedding:pending');
      }

      // digest: check trace
      if (digestedIds.has(itemId) || digestedIds.has(`session-${itemId}`)) {
        this.advance(itemId, 'session', 'digest', 'succeeded');
        bumpStage('digest:succeeded');
      } else {
        bumpStage('digest:pending');
      }
    }

    // --- Spores ---
    const sporesDir = path.join(vaultDir, 'spores');
    for (const filePath of this.walkMarkdownFiles(sporesDir)) {
      const itemId = path.basename(filePath, '.md');
      const relativePath = path.relative(vaultDir, filePath);

      this.register(itemId, 'spore', relativePath);
      registered++;

      // capture: file exists → succeeded
      this.advance(itemId, 'spore', 'capture', 'succeeded');
      bumpStage('capture:succeeded');

      // embedding: check vector index
      if (vectorIndex?.has(itemId)) {
        this.advance(itemId, 'spore', 'embedding', 'succeeded');
        bumpStage('embedding:succeeded');
      } else {
        bumpStage('embedding:pending');
      }

      // consolidation: cannot reliably infer → leave as pending
      bumpStage('consolidation:pending');

      // digest: check trace
      if (digestedIds.has(itemId)) {
        this.advance(itemId, 'spore', 'digest', 'succeeded');
        bumpStage('digest:succeeded');
      } else {
        bumpStage('digest:pending');
      }
    }

    // --- Artifacts ---
    const artifactsDir = path.join(vaultDir, 'artifacts');
    for (const filePath of this.walkMarkdownFiles(artifactsDir)) {
      const itemId = path.basename(filePath, '.md');
      const relativePath = path.relative(vaultDir, filePath);

      this.register(itemId, 'artifact', relativePath);
      registered++;

      // capture: file exists → succeeded
      this.advance(itemId, 'artifact', 'capture', 'succeeded');
      bumpStage('capture:succeeded');

      // embedding: check vector index
      if (vectorIndex?.has(itemId)) {
        this.advance(itemId, 'artifact', 'embedding', 'succeeded');
        bumpStage('embedding:succeeded');
      } else {
        bumpStage('embedding:pending');
      }

      // digest: check trace
      if (digestedIds.has(itemId)) {
        this.advance(itemId, 'artifact', 'digest', 'succeeded');
        bumpStage('digest:succeeded');
      } else {
        bumpStage('digest:pending');
      }
    }

    return { registered, stages };
  }

  /**
   * Read digest trace JSONL and collect all note IDs that appear in any
   * substrate array. Returns an empty Set if the trace file doesn't exist.
   */
  private loadDigestedIds(tracePath?: string): Set<string> {
    const ids = new Set<string>();
    if (!tracePath) return ids;

    let content: string;
    try {
      content = fs.readFileSync(tracePath, 'utf-8').trim();
    } catch {
      return ids;
    }

    if (!content) return ids;

    for (const line of content.split('\n')) {
      try {
        const record = JSON.parse(line) as {
          substrate?: {
            sessions?: string[];
            spores?: string[];
            plans?: string[];
            artifacts?: string[];
            team?: string[];
          };
        };
        if (record.substrate) {
          for (const arr of Object.values(record.substrate)) {
            if (Array.isArray(arr)) {
              for (const id of arr) {
                ids.add(id);
              }
            }
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return ids;
  }

  /**
   * Walk spore files and collect session IDs they reference.
   * Used to infer whether extraction has been completed for a session.
   */
  private collectSporeSessionIds(vaultDir: string): Set<string> {
    const sessionIds = new Set<string>();
    const sporesDir = path.join(vaultDir, 'spores');

    for (const filePath of this.walkMarkdownFiles(sporesDir)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;

        // Look for session field in frontmatter
        // Format: session: "[[session-<id>]]" or session: "session-<id>" or session: "<id>"
        const sessionMatch = fmMatch[1].match(/^session:\s*(?:"\[\[)?([^"\]]+)/m);
        if (sessionMatch) {
          const rawSession = sessionMatch[1].trim();
          sessionIds.add(rawSession);
          // Also add bare ID if it has session- prefix
          if (rawSession.startsWith('session-')) {
            sessionIds.add(rawSession.slice('session-'.length));
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return sessionIds;
  }

  /**
   * Recursively walk a directory and collect all .md file paths.
   * Returns empty array if the directory doesn't exist.
   */
  private walkMarkdownFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];

    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.walkMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(fullPath);
      }
    }

    return results;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }
}
