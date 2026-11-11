import type { RelationalStore } from '../core/adapters.js';
import { admitProject, type ProjectCreator } from '../db/storage/projects.js';
import { projectArchivedAt } from '../db/storage/project-archive.js';

export const PROJECT_ARCHIVED = 'this project is archived on the server; unarchive it from the dashboard to resume capture';
type ProjectResolution = { resolved: true; archived: boolean } | { resolved: false; reason?: string };

/** Existing Projects remain addressable when creation is disabled. */
export async function resolveProject(db: RelationalStore, projectId: string, now: number, actor: ProjectCreator = { kind: 'operator' }): Promise<ProjectResolution> {
  const held = await projectArchivedAt(db, projectId);
  if (held !== null) return { resolved: true, archived: held.archived_at !== null };
  const result = await admitProject(db, { projectId, name: projectId, now }, actor);
  return result.resolved ? { resolved: true, archived: result.archived } : result;
}

