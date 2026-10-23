/**
 * The artifacts a session reported it created, oldest first, one keyset page at a time.
 *
 * `linked` is decided here, once, for every reader: a URL is offered as a link only on a host this read names at the
 * default https port, and is shown as text everywhere else. `idx_session_artifacts_session` serves the read.
 */
import type { RelationalStore } from '../core/adapters.js';
import { ARTIFACT_COLUMNS, type ArtifactKind, type SessionArtifactRow } from '../core/session-artifacts.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** The hosts whose artifact URLs a reader is offered as links. */
export const LINKED_ARTIFACT_HOSTS: readonly string[] = ['github.com'];

export interface SessionArtifact {
  id: string;
  kind: ArtifactKind;
  artifactId: string;
  url: string;
  /** Whether the URL's host is one a reader is offered as a link. */
  linked: boolean;
  reportedAt: number;
}

/** Linked only on a named host at the default https port: a URL naming any other port is another authority. */
const linkedHost = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.port === '' && LINKED_ARTIFACT_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
};

/** One page of the session's reported artifacts, or null for a malformed cursor. */
export async function listSessionArtifacts(
  db: RelationalStore, scope: ReadScope, sessionId: string, opts: { limit?: number; cursor?: string } = {},
): Promise<Page<SessionArtifact> | null> {
  const k = keyset(opts, { order: 'reported_at', id: 'id', direction: 'ASC' });
  if (k === null) return null;
  const { results } = await db.prepare(`SELECT ${ARTIFACT_COLUMNS} FROM session_artifacts
      WHERE project_id = ? AND session_id = ?${k.where === '' ? '' : ` AND ${k.where}`}
      ORDER BY reported_at, id LIMIT ?`)
    .bind(scope.projectId, sessionId, ...k.params, k.limit + 1)
    .all<SessionArtifactRow>();
  const paged = page(results, k.limit, (row) => ({ createdAt: row.reportedAt, id: row.id }));
  return { cursor: paged.cursor, rows: paged.rows.map(shape) };
}

export function shape(row: SessionArtifactRow): SessionArtifact {
  return { id: row.id, kind: row.kind, artifactId: row.artifactId, url: row.url, linked: linkedHost(row.url), reportedAt: row.reportedAt };
}
