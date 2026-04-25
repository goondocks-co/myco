import type { Database } from 'bun:sqlite';
import type { CanopyEntry } from '../../db/schema.js';

const COLUMNS = [
  'project_id',
  'machine_id',
  'path',
  'content_hash',
  'size_bytes',
  'token_estimate',
  'line_count',
  'language',
  'exports_json',
  'imports_json',
  'top_comment',
  'mechanical_updated_at',
  'llm_description',
  'llm_updated_at',
] as const;

const PLACEHOLDERS = COLUMNS.map(() => '?').join(', ');
const COL_LIST = COLUMNS.join(', ');

/**
 * Upsert a single CanopyEntry. Mechanical columns overwrite on conflict.
 * `llm_description` and `llm_updated_at` are deliberately untouched here so
 * a Tier 2 description survives subsequent mechanical rescans; the
 * `canopy-describe` task is the only writer of those columns.
 */
export function upsertCanopyEntry(db: Database, entry: CanopyEntry): void {
  db.prepare(
    `INSERT INTO canopy_entries (${COL_LIST})
     VALUES (${PLACEHOLDERS})
     ON CONFLICT (project_id, path) DO UPDATE SET
       machine_id            = EXCLUDED.machine_id,
       content_hash          = EXCLUDED.content_hash,
       size_bytes            = EXCLUDED.size_bytes,
       token_estimate        = EXCLUDED.token_estimate,
       line_count            = EXCLUDED.line_count,
       language              = EXCLUDED.language,
       exports_json          = EXCLUDED.exports_json,
       imports_json          = EXCLUDED.imports_json,
       top_comment           = EXCLUDED.top_comment,
       mechanical_updated_at = EXCLUDED.mechanical_updated_at`,
  ).run(
    entry.project_id,
    entry.machine_id,
    entry.path,
    entry.content_hash,
    entry.size_bytes,
    entry.token_estimate,
    entry.line_count,
    entry.language,
    entry.exports_json,
    entry.imports_json,
    entry.top_comment,
    entry.mechanical_updated_at,
    entry.llm_description,
    entry.llm_updated_at,
  );
}

/**
 * Delete rows whose path is not in the provided set, scoped by project.
 * Used by the full scan to tombstone files removed since the last walk. The
 * MVP deletes outright (per plan); a soft-delete column can be added later
 * if a downstream consumer needs lineage.
 */
export function deleteMissingEntries(
  db: Database,
  projectId: string,
  visitedPaths: ReadonlySet<string>,
): number {
  if (visitedPaths.size === 0) {
    return db.prepare('DELETE FROM canopy_entries WHERE project_id = ?').run(projectId).changes;
  }
  db.exec('DROP TABLE IF EXISTS _canopy_visited');
  db.exec('CREATE TEMP TABLE _canopy_visited (path TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT OR IGNORE INTO _canopy_visited (path) VALUES (?)');
  for (const p of visitedPaths) insert.run(p);
  const info = db.prepare(
    `DELETE FROM canopy_entries
       WHERE project_id = ?
         AND path NOT IN (SELECT path FROM _canopy_visited)`,
  ).run(projectId);
  db.exec('DROP TABLE IF EXISTS _canopy_visited');
  return info.changes;
}

export interface ExistingHashRow {
  path: string;
  content_hash: string;
  size_bytes: number;
}

/** Snapshot of project rows used by the delta scan to skip unchanged files. */
export function listExistingHashes(db: Database, projectId: string): Map<string, ExistingHashRow> {
  const rows = db.prepare(
    'SELECT path, content_hash, size_bytes FROM canopy_entries WHERE project_id = ?',
  ).all(projectId) as ExistingHashRow[];
  const out = new Map<string, ExistingHashRow>();
  for (const r of rows) out.set(r.path, r);
  return out;
}

/** Delete a single row by (project_id, path). Used by rescan-single on file removal. */
export function deleteCanopyEntry(db: Database, projectId: string, relPath: string): number {
  return db.prepare(
    'DELETE FROM canopy_entries WHERE project_id = ? AND path = ?',
  ).run(projectId, relPath).changes;
}
