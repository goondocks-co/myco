/**
 * Runtime migrations that can't live in SQL DDL. Registered here, invoked
 * once per vault at daemon startup; completion is recorded in the
 * `migration_tasks` table so subsequent starts skip them.
 */

import type { Database } from 'better-sqlite3';
import { epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { DaemonLogger } from './logger.js';
import type { EmbeddingManager } from './embedding/index.js';

export interface MigrationTaskDeps {
  db: Database;
  embeddingManager: EmbeddingManager;
  logger: DaemonLogger;
}

interface MigrationTask {
  /** Stable key. Do NOT rename once released. */
  name: string;
  description: string;
  /** Errors bubble up so the task stays unmarked and retries on next start. */
  run: (deps: MigrationTaskDeps) => void | Promise<void>;
}

const MIGRATION_TASKS: ReadonlyArray<MigrationTask> = [
  {
    name: 'vector-metadata-reindex-0.21.1',
    description: 'Clear and re-embed all vectors to pick up metadata columns added in 0.21.1',
    run: ({ embeddingManager }) => {
      // rebuildAll clears vectors and marks records pending; the background
      // embedding-reconcile job drains them — we don't wait here.
      embeddingManager.rebuildAll();
    },
  },
];

export async function runPendingMigrationTasks(deps: MigrationTaskDeps): Promise<void> {
  const { db, logger } = deps;
  const alreadyApplied = new Set(
    (db.prepare(`SELECT name FROM migration_tasks`).all() as Array<{ name: string }>)
      .map((r) => r.name),
  );

  for (const task of MIGRATION_TASKS) {
    if (alreadyApplied.has(task.name)) continue;
    logger.info(LOG_KINDS.DAEMON_START, `Running migration task: ${task.name} — ${task.description}`);
    try {
      await task.run(deps);
      db.prepare(
        `INSERT INTO migration_tasks (name, applied_at) VALUES (?, ?)
         ON CONFLICT (name) DO NOTHING`,
      ).run(task.name, epochSeconds());
      logger.info(LOG_KINDS.DAEMON_START, `Completed migration task: ${task.name}`);
    } catch (err) {
      logger.warn(LOG_KINDS.DAEMON_START, `Migration task failed, will retry on next start`, {
        task: task.name,
        error: (err as Error).message,
      });
    }
  }
}
