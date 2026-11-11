import type { RelationalStore } from '../../core/adapters.js';
import { first, read } from '../index.js';

const archived = read<[project: string], { archived_at: number | null }>({ name: 'storage.projectArchivedAt', sql:
  'SELECT archived_at FROM projects WHERE project_id = ?1' });

/** When a Project was archived (null while it takes capture), or null when no Project carries the id. */
export async function projectArchivedAt(db: RelationalStore, projectId: string): Promise<{ archived_at: number | null } | null> {
  return first(db, archived.bind(projectId));
}
