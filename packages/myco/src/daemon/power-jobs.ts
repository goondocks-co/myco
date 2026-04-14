/**
 * Power-managed job registrations.
 *
 * Extracted from main.ts — registers the 4 core housekeeping jobs
 * with the PowerManager: embedding reconciliation, session maintenance,
 * log retention, and auto-backup.
 */

import type { Database } from 'better-sqlite3';
import type { DaemonLogger } from './logger.js';
import type { PowerManager } from './power.js';
import type { EmbeddingManager } from './embedding/manager.js';
import type { SessionRegistry } from './lifecycle.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { DatabaseMaintenanceManager } from './database/manager.js';
import { runSessionMaintenance } from './jobs/session-maintenance.js';
import { createBackup } from './backup.js';
import { deleteOldLogs } from '@myco/db/queries/logs.js';
import {
  listStaleStagingDirs,
  cleanupStagedSkill,
} from '@myco/agent/tools/skill-staging.js';
import { EMBEDDING_BATCH_SIZE, MS_PER_DAY, MS_PER_HOUR } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

/**
 * Maximum age for a staging directory before the sweep reclaims it.
 * 24 hours is well beyond any legitimate skill-generate run — a task
 * that failed to clean up via the executor hook has long since gone.
 */
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PowerJobDeps {
  embeddingManager: EmbeddingManager;
  registry: SessionRegistry;
  logger: DaemonLogger;
  config: MycoConfig;
  db: Database;
  backupDir: string;
  machineId: string;
  vaultDir: string;
  databaseManager: DatabaseMaintenanceManager;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPowerJobs(powerManager: PowerManager, deps: PowerJobDeps): void {
  const { embeddingManager, registry, logger, config, db, backupDir, machineId, vaultDir, databaseManager } = deps;

  let reconcileRunning = false;
  powerManager.register({
    name: 'embedding-reconcile',
    runIn: ['active', 'idle'],
    fn: async () => {
      if (reconcileRunning) return;
      reconcileRunning = true;
      try {
        await embeddingManager.reconcile(EMBEDDING_BATCH_SIZE);
      } finally {
        reconcileRunning = false;
      }
    },
  });

  powerManager.register({
    name: 'session-maintenance',
    runIn: ['active', 'idle', 'sleep'],
    fn: () => runSessionMaintenance({
      logger,
      registeredSessionIds: () => registry.sessions,
      embeddingManager,
      vaultDir,
      staleThresholdMs: config.daemon.stale_session_threshold_ms,
    }),
  });

  powerManager.register({
    name: 'log-retention',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      const retentionDays = config.daemon.log_retention_days;
      const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
      const deleted = deleteOldLogs(cutoff);
      if (deleted > 0) {
        logger.info(LOG_KINDS.LOG_RETENTION, `Deleted ${deleted} log entries older than ${retentionDays} days`, { deleted, retention_days: retentionDays });
      }
    },
  });

  // Auto-backup: create a local SQL dump during idle/sleep cycles
  powerManager.register({
    name: 'auto-backup',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      try {
        logger.info(LOG_KINDS.BACKUP_START, 'Auto-backup starting');
        const filePath = createBackup(db, backupDir, machineId);
        logger.info(LOG_KINDS.BACKUP_COMPLETE, 'Auto-backup complete', { file_path: filePath });
      } catch (err) {
        logger.error(LOG_KINDS.BACKUP_ERROR, 'Auto-backup failed', { error: (err as Error).message });
      }
    },
  });

  // Database optimize: run VACUUM + WAL checkpoint + ANALYZE during idle/sleep cycles
  powerManager.register({
    name: 'database-optimize',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      if (!config.maintenance?.auto_optimize) return;
      const intervalMs = (config.maintenance.auto_optimize_interval_hours ?? 24) * MS_PER_HOUR;
      const lastRun = await databaseManager.getLastOptimizeAt();
      if (lastRun !== null && Date.now() - lastRun < intervalMs) return;
      try {
        await databaseManager.optimize();
      } catch (err) {
        logger.error(LOG_KINDS.DATABASE_ERROR, 'Auto-optimize failed', {
          error: (err as Error).message,
        });
      }
    },
  });

  // Staging GC: belt-and-suspenders cleanup for skill-generate staging
  // dirs that escaped the executor's per-run failure hook — e.g., a
  // daemon crash between draft stage and the failure handler. Running
  // on every idle tick is cheap because the happy path has zero stale
  // entries and the check is a single readdir on a typically-empty
  // directory.
  powerManager.register({
    name: 'staging-gc',
    runIn: ['idle', 'sleep'],
    fn: async () => {
      const stale = listStaleStagingDirs(vaultDir, STAGING_MAX_AGE_MS);
      if (stale.length === 0) return;
      for (const candidateId of stale) {
        cleanupStagedSkill(vaultDir, candidateId);
      }
      logger.info(LOG_KINDS.MAINTENANCE_STAGING_GC, 'Staging GC swept stale skill drafts', {
        count: stale.length,
        candidate_ids: stale,
      });
    },
  });
}
