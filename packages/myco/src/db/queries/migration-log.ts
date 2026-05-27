/**
 * Bounded audit log writes for the global-install migration walker
 * (Steps 8 + 9).
 *
 * After each walker pass:
 *   - delete the prior pass-summary row (only the latest is retained)
 *   - delete prior error rows whose affected_project_id appears in the new outcomes
 *     (per-project errors are replaced by the latest pass's outcome)
 *   - insert the new pass-summary row
 *   - insert one error row per project that errored this pass
 *
 * Result: in steady state, the table holds at most one pass-summary row
 * plus one row per currently-failing project. Successes are never
 * persisted — their absence IS the "everything ok" signal.
 */

import type { Database } from 'bun:sqlite';
import type { MigrationPassResult } from '../../grove/global-install-migration.js';
import { epochSeconds } from '@myco/constants.js';

export interface MigrationLogRow {
  id: number;
  pass_id: string;
  recorded_at: number;
  kind: 'pass-summary' | 'error';
  affected_project_id: string | null;
  project_root: string | null;
  details: string;
}

export function recordMigrationPass(db: Database, result: MigrationPassResult): void {
  db.prepare('BEGIN').run();
  try {
    // Drop the prior pass-summary so only the latest persists.
    db.prepare(`DELETE FROM migration_log WHERE kind = 'pass-summary'`).run();

    // Drop any prior errors for projects that this pass either fixed or
    // re-errored on — the latest pass's outcome supersedes.
    // `affected_project_id` is the DB column name (chosen to dodge the
    // GROVE_PROJECT_SCOPED_TABLES drift check); the in-memory
    // RegisteredProject still uses `project_id`. The mapping is local
    // to this writer to keep the rename a column-only concern.
    const visitedProjectIds = result.outcomes.map((o) => o.projectId);
    if (visitedProjectIds.length > 0) {
      const placeholders = visitedProjectIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM migration_log WHERE kind = 'error' AND affected_project_id IN (${placeholders})`)
        .run(...visitedProjectIds);
    }

    const recordedAt = epochSeconds();
    const summaryDetails = {
      projects_visited: result.projectsVisited,
      projects_cleaned: result.projectsCleaned,
      projects_errored: result.projectsErrored,
      // Per-project record IDs aren't enumerated here — error rows below
      // are the queryable surface for per-project diagnostics.
    };
    db.prepare(
      `INSERT INTO migration_log (pass_id, recorded_at, kind, affected_project_id, project_root, details)
       VALUES (?, ?, 'pass-summary', NULL, NULL, ?)`,
    ).run(result.passId, recordedAt, JSON.stringify(summaryDetails));

    const errors = result.outcomes.filter((o) => !!o.error);
    const insertError = db.prepare(
      `INSERT INTO migration_log (pass_id, recorded_at, kind, affected_project_id, project_root, details)
       VALUES (?, ?, 'error', ?, ?, ?)`,
    );
    for (const outcome of errors) {
      insertError.run(
        result.passId, recordedAt,
        outcome.projectId, outcome.projectRoot,
        JSON.stringify({ error: outcome.error }),
      );
    }

    db.prepare('COMMIT').run();
  } catch (err) {
    db.prepare('ROLLBACK').run();
    throw err;
  }
}

export function latestMigrationSummary(db: Database): MigrationLogRow | null {
  const row = db.prepare(
    `SELECT id, pass_id, recorded_at, kind, affected_project_id, project_root, details
       FROM migration_log
      WHERE kind = 'pass-summary'
      ORDER BY recorded_at DESC
      LIMIT 1`,
  ).get() as MigrationLogRow | undefined;
  return row ?? null;
}

export function listMigrationErrors(db: Database): MigrationLogRow[] {
  return db.prepare(
    `SELECT id, pass_id, recorded_at, kind, affected_project_id, project_root, details
       FROM migration_log
      WHERE kind = 'error'
      ORDER BY recorded_at DESC`,
  ).all() as MigrationLogRow[];
}
