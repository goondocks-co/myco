/**
 * Git remotes as Project names: the middle leg of Project Resolution.
 *
 * A tool call names its Project by a portable Project id or by the repository's
 * git remote. An id is the Project itself; a remote is a name a Project answers
 * to, and this module owns the mapping.
 *
 * **Normalization is what makes one repository one name.** The same repository
 * is written five ways — `git@host:owner/repo.git`, `ssh://git@host/owner/repo`,
 * `https://host/owner/repo.git`, with a port, with credentials — and all five
 * name one Project. Host case is folded and path case is kept: hosts are
 * case-insensitive, repository paths are not on every forge, so folding the
 * path would merge two repositories that differ only in case.
 *
 * **Different remotes never merge.** `remote` is the primary key, so one remote
 * names at most one Project by the shape of the table rather than by a rule a
 * writer has to keep. A remote already bound stays bound: a second Project
 * claiming it is dropped, and the ignored write is emitted so the collision is
 * visible to an owner rather than silent. Correcting a genuine duplicate is
 * Project Reassignment, an owner-side operation, not a rebind here.
 */
import type { RelationalStore } from './adapters.js';
import { emit } from '../telemetry.js';

export { MAX_REMOTE_CHARS, normalizeRemote } from '@goondocks/myco-shared/member-protocol';

/** The Project a remote names, or null where no Project has claimed it. */
export async function projectForRemote(db: RelationalStore, remote: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT project_id AS projectId FROM project_remotes WHERE remote = ?`)
    .bind(remote)
    .first<{ projectId: string }>();
  return row?.projectId ?? null;
}

/** The Project a remote names and whether it is archived, or null where no Project has claimed the remote. */
export async function remoteHolder(db: RelationalStore, remote: string): Promise<{ projectId: string; archived: boolean } | null> {
  const row = await db
    .prepare(`SELECT p.project_id AS projectId, p.archived_at AS archivedAt
                FROM projects p WHERE p.project_id = (SELECT r.project_id FROM project_remotes r WHERE r.remote = ?)`)
    .bind(remote)
    .first<{ projectId: string; archivedAt: number | null }>();
  return row === null ? null : { projectId: row.projectId, archived: row.archivedAt !== null };
}

/**
 * Binds a remote to a Project the first time it is seen, and answers whether
 * this call is what bound it.
 *
 * A remote another Project already holds is left alone and answered false. The
 * caller is not told, and the ignored write is emitted: a member whose
 * repository resolves to someone else's Project is a real misconfiguration, and
 * a silent drop is how it would stay invisible.
 */
export async function recordProjectRemote(db: RelationalStore, projectId: string, remote: string, now: number): Promise<boolean> {
  const written = await db
    .prepare(`INSERT OR IGNORE INTO project_remotes (remote, project_id, first_seen_at) VALUES (?, ?, ?)`)
    .bind(remote, projectId, now)
    .run();
  const bound = written.meta.changes === 1;
  if (!bound) emit({ kind: 'remote_bound', remote, projectId, status: 'held' });
  return bound;
}

/** What resolving a member's repository to a project came to. */
export type RepositoryResolution =
  | { resolved: true; projectId: string; name: string; created: boolean }
  | { resolved: false; reason: 'auto_create_off' | 'refused' | 'archived' };

/**
 * The project a member's repository belongs to: the one its remote names, or one created for it and named `name`.
 *
 * One batch decides it, in a transaction: the project is created only while no project holds the remote, the remote is
 * bound only to a project this call created, and the answer is whichever project holds the remote once both have run.
 * Two machines, or two sessions of one, resolving a new repository at once create one project and both answer it: the
 * remote's primary key decides between them. With no remote, a project is created by name; the member holds the only
 * guard against a second, its lock on the repository. `allowCreate` false answers only a project the remote already
 * names.
 */
export async function resolveRepository(
  db: RelationalStore, repository: { remote: string | null; name: string; allowCreate: boolean; projectId: string; now: number; maxProjects: number },
): Promise<RepositoryResolution> {
  const { remote, name, allowCreate, projectId, now, maxProjects } = repository;
  const capacity = `(SELECT COUNT(*) FROM projects WHERE archived_at IS NULL) < ?`;
  if (remote === null) {
    if (!allowCreate) return { resolved: false, reason: 'auto_create_off' };
    const made = await db.prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at) SELECT ?, ?, ? WHERE ${capacity}`)
      .bind(projectId, name, now, maxProjects).run();
    return made.meta.changes === 1 ? { resolved: true, projectId, name, created: true } : { resolved: false, reason: 'refused' };
  }
  const [, , held] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at)
                  SELECT ?, ?, ? WHERE ? = 1 AND NOT EXISTS (SELECT 1 FROM project_remotes WHERE remote = ?) AND ${capacity}`)
      .bind(projectId, name, now, allowCreate ? 1 : 0, remote, maxProjects),
    db.prepare(`INSERT OR IGNORE INTO project_remotes (remote, project_id, first_seen_at)
                  SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE project_id = ?)`)
      .bind(remote, projectId, now, projectId),
    db.prepare(`SELECT p.project_id AS projectId, p.name, p.archived_at AS archivedAt
                  FROM projects p WHERE p.project_id = (SELECT r.project_id FROM project_remotes r WHERE r.remote = ?)`).bind(remote),
  ]);
  const row = held!.results[0] as { projectId: string; name: string; archivedAt: number | null } | undefined;
  if (row === undefined) return { resolved: false, reason: allowCreate ? 'refused' : 'auto_create_off' };
  if (row.archivedAt !== null) return { resolved: false, reason: 'archived' };
  return { resolved: true, projectId: row.projectId, name: row.name, created: row.projectId === projectId };
}
