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

/** The forms a remote may arrive in; anything else is not a remote. */
const SCP_FORM = /^(?:(?<user>[^@/\s]+)@)?(?<host>[^:/\s]+):(?<path>[^\s]+)$/;
const URL_SCHEMES = new Set(['ssh:', 'git:', 'http:', 'https:', 'git+ssh:', 'git+https:']);

/** The most a stored remote may carry, bounding a caller that would grow one without limit. */
export const MAX_REMOTE_CHARS = 512;

const tidy = (host: string, rawPath: string): string | null => {
  const path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (path.length === 0) return null;
  const name = `${host.toLowerCase()}/${path}`;
  return name.length <= MAX_REMOTE_CHARS ? name : null;
};

/**
 * One repository's canonical name — `<host>/<path>` — or null when the value is
 * not a git remote at all.
 *
 * Null is what keeps the tenancy argument's two branches disjoint: a value the
 * Project id grammar accepts is an id, a value this accepts is a remote, and
 * anything else resolves to nothing.
 */
export function normalizeRemote(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REMOTE_CHARS) return null;

  if (trimmed.includes('://')) {
    let url: URL;
    try { url = new URL(trimmed); } catch { return null; }
    if (!URL_SCHEMES.has(url.protocol) || url.hostname.length === 0) return null;
    return tidy(url.hostname, url.pathname);
  }

  const scp = SCP_FORM.exec(trimmed);
  if (scp?.groups === undefined) return null;
  const { host, path } = scp.groups;
  if (host === undefined || path === undefined || path.startsWith('/')) return null;
  return tidy(host, path);
}

/** The Project a remote names, or null where no Project has claimed it. */
export async function projectForRemote(db: RelationalStore, remote: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT project_id AS projectId FROM project_remotes WHERE remote = ?`)
    .bind(remote)
    .first<{ projectId: string }>();
  return row?.projectId ?? null;
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
