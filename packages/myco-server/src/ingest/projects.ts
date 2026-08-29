import type { RelationalStore } from '../core/adapters.js';
import { MAX_PROJECTS } from '../constants.js';

/**
 * Resolves the Project a request names, creating it if the Deployment does not
 * hold it yet.
 *
 * Member Access is Deployment-wide, so a member reaching a Project the server has
 * never seen is the ordinary case — a new checkout, a new repository — not an
 * error. What it must not be is unlimited. The credential quota bounds BYTES per
 * credential and says nothing about ROWS in `projects`, so a credential that
 * cycles the header through fresh names would fill the table while staying well
 * inside its quota; an ephemeral sandbox's credential is the cheapest way to do
 * it. `MAX_PROJECTS` is that bound.
 *
 * The ceiling is enforced inside the INSERT rather than around it: SQLite
 * evaluates the count as part of the statement, and writes are serialized, so
 * concurrent creations each see the rows the others have already written and the
 * table cannot pass the ceiling by racing.
 *
 * Steady state is one statement — a primary-key lookup. Only a Project that does
 * not exist costs a second.
 */
/** The refusal text for capture into an archived Project, on every route and through every writer. */
export const PROJECT_ARCHIVED = 'this project is archived on the server; unarchive it from the dashboard to resume capture';

export type ProjectResolution = { resolved: true; archived: boolean } | { resolved: false };

const LOOKUP = `SELECT archived_at FROM projects WHERE project_id = ?`;
const found = (row: { archived_at: number | null } | null): ProjectResolution => (row === null ? { resolved: false } : { resolved: true, archived: row.archived_at !== null });

export async function resolveProject(db: RelationalStore, projectId: string, nowMs: number): Promise<ProjectResolution> {
  const existing = await db.prepare(LOOKUP).bind(projectId).first<{ archived_at: number | null }>();
  if (existing !== null) return found(existing);

  const created = await db
    .prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at)
              SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM projects) < ?`)
    .bind(projectId, projectId, nowMs, MAX_PROJECTS)
    .run();
  if (created.meta.changes === 1) return { resolved: true, archived: false };

  // Zero changes is either the ceiling or a concurrent creation of this same
  // Project, which is a success. One lookup separates them.
  return found(await db.prepare(LOOKUP).bind(projectId).first<{ archived_at: number | null }>());
}
