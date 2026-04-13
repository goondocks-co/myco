import fs from 'node:fs';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  getDatabaseFileStats,
  getTablesBreakdown,
  getIndexesList,
  getSchemaInfo,
  getLastDatabaseLogTimestamp,
  getLastDatabaseLogTimestamps,
  runVacuum,
  runAnalyze,
  runReindex,
  runIntegrityCheck,
  runForeignKeyCheck,
  runWalCheckpointTruncate,
  runPragmaOptimize,
  runFtsOptimize,
  listFtsTableNames,
} from '@myco/db/queries/database.js';
import type { Logger } from '../logger.js';
import {
  type DatabaseDetails,
  type OptimizeAction,
  type OptimizeResult,
  type VacuumResult,
  type ReindexResult,
  type IntegrityResult,
  VacuumPrecheckError,
} from './types.js';

const VACUUM_FREE_SPACE_MULTIPLIER = 2;

export class DatabaseMaintenanceManager {
  constructor(
    private dbPath: string,
    private vaultDir: string,
    private logger: Logger,
  ) {}

  async getDetails(): Promise<DatabaseDetails> {
    const file = getDatabaseFileStats(this.dbPath);
    const schema = getSchemaInfo();
    const tables = getTablesBreakdown();
    const indexes = getIndexesList();

    // Batch the four last-run lookups into a single log_entries query.
    const lastRuns = getLastDatabaseLogTimestamps([
      LOG_KINDS.DATABASE_OPTIMIZE,
      LOG_KINDS.DATABASE_VACUUM,
      LOG_KINDS.DATABASE_INTEGRITY_CHECK,
      LOG_KINDS.DATABASE_INTEGRITY_ISSUES,
    ]);
    const optimizeMs = lastRuns.get(LOG_KINDS.DATABASE_OPTIMIZE) ?? null;
    const vacuumMs = lastRuns.get(LOG_KINDS.DATABASE_VACUUM) ?? null;
    const integrityOkMs = lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_CHECK) ?? null;
    const integrityIssuesMs = lastRuns.get(LOG_KINDS.DATABASE_INTEGRITY_ISSUES) ?? null;

    let last_integrity_check: { at: string; status: 'ok' | 'issues' } | null = null;
    if (integrityOkMs !== null || integrityIssuesMs !== null) {
      const okMs = integrityOkMs ?? 0;
      const issuesMs = integrityIssuesMs ?? 0;
      if (okMs >= issuesMs) {
        last_integrity_check = { at: new Date(okMs).toISOString(), status: 'ok' };
      } else {
        last_integrity_check = { at: new Date(issuesMs).toISOString(), status: 'issues' };
      }
    }

    return {
      file,
      schema,
      tables,
      indexes,
      last_optimize_at: optimizeMs ? new Date(optimizeMs).toISOString() : null,
      last_vacuum_at: vacuumMs ? new Date(vacuumMs).toISOString() : null,
      last_integrity_check,
    };
  }

  async getLastOptimizeAt(): Promise<number | null> {
    return getLastDatabaseLogTimestamp(LOG_KINDS.DATABASE_OPTIMIZE);
  }

  async optimize(): Promise<OptimizeResult> {
    const startedAt = Date.now();
    const completed: OptimizeAction[] = [];
    const failed: OptimizeAction[] = [];

    const steps: Array<{ name: string; fn: () => void }> = [
      { name: 'analyze', fn: runAnalyze },
      { name: 'pragma_optimize', fn: runPragmaOptimize },
      ...listFtsTableNames().map((tbl) => ({
        name: 'fts_optimize:' + tbl,
        fn: () => runFtsOptimize(tbl),
      })),
      // wal_checkpoint_truncate returns WalCheckpointResult; if busy !== 0 another
      // reader blocked the checkpoint — log a warning but don't fail the step.
      {
        name: 'wal_checkpoint_truncate',
        fn: () => {
          const result = runWalCheckpointTruncate();
          if (result.busy !== 0) {
            this.logger.warn(LOG_KINDS.DATABASE_ERROR, 'wal_checkpoint blocked by reader', {
              busy: result.busy,
              log: result.log,
              checkpointed: result.checkpointed,
            });
          }
        },
      },
    ];

    for (const step of steps) {
      const stepStart = Date.now();
      try {
        step.fn();
        completed.push({ name: step.name, duration_ms: Date.now() - stepStart, ok: true });
      } catch (err) {
        const error = (err as Error).message;
        failed.push({ name: step.name, duration_ms: Date.now() - stepStart, ok: false, error });
        this.logger.warn(LOG_KINDS.DATABASE_ERROR, 'optimize step failed: ' + step.name, { error });
      }
    }

    const duration_ms = Date.now() - startedAt;
    this.logger.info(LOG_KINDS.DATABASE_OPTIMIZE, 'Database optimize complete', {
      completed: completed.length,
      failed: failed.length,
      duration_ms,
    });

    return { actions_completed: completed, actions_failed: failed, duration_ms };
  }

  async vacuum(): Promise<VacuumResult> {
    const size_before = this.fileSize();

    // Disk precheck — VACUUM rebuilds the DB into a temp file before swapping.
    // If the disk is too full the user can be left in a broken state, so refuse.
    const stats = await fs.promises.statfs(this.vaultDir);
    const free_bytes = Number(stats.bavail) * Number(stats.bsize);
    const required_bytes = size_before * VACUUM_FREE_SPACE_MULTIPLIER;
    if (free_bytes < required_bytes) {
      throw new VacuumPrecheckError(required_bytes, free_bytes);
    }

    const startedAt = Date.now();
    runVacuum();
    const duration_ms = Date.now() - startedAt;
    const size_after = this.fileSize();
    const freed_bytes = size_before - size_after;

    this.logger.info(LOG_KINDS.DATABASE_VACUUM, 'Database vacuum complete', {
      size_before,
      size_after,
      freed_bytes,
      duration_ms,
    });

    return { size_before, size_after, freed_bytes, duration_ms };
  }

  async reindex(): Promise<ReindexResult> {
    const startedAt = Date.now();
    runReindex();
    const duration_ms = Date.now() - startedAt;

    this.logger.info(LOG_KINDS.DATABASE_REINDEX, 'Database reindex complete', { duration_ms });

    return { duration_ms };
  }

  async integrityCheck(): Promise<IntegrityResult> {
    const startedAt = Date.now();
    const integrity = runIntegrityCheck();
    const fkViolations = runForeignKeyCheck();
    const duration_ms = Date.now() - startedAt;
    const status = integrity.status === 'ok' && fkViolations.length === 0 ? 'ok' : 'issues';

    // Use distinct kinds based on outcome so the stored history preserves
    // status info; getDetails() reads the more recent of the two kinds to
    // determine last_integrity_check.status.
    const logKind = status === 'ok'
      ? LOG_KINDS.DATABASE_INTEGRITY_CHECK
      : LOG_KINDS.DATABASE_INTEGRITY_ISSUES;
    this.logger.info(logKind, 'Database integrity check complete', {
      status,
      issue_count: integrity.issues.length,
      fk_violations: fkViolations.length,
      duration_ms,
    });

    return {
      status,
      issues: integrity.issues,
      fk_violations: fkViolations.length,
      duration_ms,
    };
  }

  private fileSize(): number {
    try {
      return fs.statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }
}
