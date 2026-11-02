import type { RelationalStore } from '../core/adapters.js';
import { admitProject, type ProjectCreator } from '../core/project-creation.js';

export const PROJECT_ARCHIVED = 'this project is archived on the server; unarchive it from the dashboard to resume capture';
export type ProjectResolution = { resolved: true; archived: boolean } | { resolved: false; reason?: string };

/** Existing Projects remain addressable when creation is disabled. */
export async function resolveProject(db: RelationalStore, projectId: string, now: number, actor: ProjectCreator = { kind: 'operator' }): Promise<ProjectResolution> {
  const held = await db.prepare('SELECT archived_at FROM projects WHERE project_id = ?').bind(projectId).first<{ archived_at: number | null }>();
  if (held !== null) return { resolved: true, archived: held.archived_at !== null };
  const result = await admitProject(db, { projectId, name: projectId, now }, actor);
  return result.resolved ? { resolved: true, archived: result.archived } : result;
}

export { createProject as createNamedProject } from '../core/project-creation.js';
