import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

/** A live Project whose repository is connected, by GitHub's ids. */
export interface ConnectedProject { projectId: string; name: string; installationId: number; repositoryId: number }
/** A live Project with no repository connected. */
export interface UnconnectedProject { projectId: string; name: string }

const connected = read<[limit: number], ConnectedProject>({ name: 'githubApp.connectedProjects', sql: `
  SELECT p.project_id AS projectId,p.name,r.github_installation_id AS installationId,r.github_repository_id AS repositoryId
    FROM project_repositories r JOIN projects p ON p.project_id=r.project_id
   WHERE p.archived_at IS NULL ORDER BY r.updated_at DESC,p.project_id LIMIT ?1` });
const connectedCount = read<[], { count: number }>({ name: 'githubApp.connectedProjectCount', sql: `
  SELECT COUNT(*) AS count FROM project_repositories r JOIN projects p ON p.project_id=r.project_id WHERE p.archived_at IS NULL` });
const unconnected = read<[limit: number], UnconnectedProject>({ name: 'githubApp.unconnectedProjects', sql: `
  SELECT p.project_id AS projectId,p.name FROM projects p
   WHERE p.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM project_repositories r WHERE r.project_id=p.project_id)
   ORDER BY p.name,p.project_id LIMIT ?1` });

/** Up to `limit` connected live Projects, most recently connected first, and how many there are in all. */
export async function connectedProjects(db: RelationalStore, limit: number): Promise<{ projects: ConnectedProject[]; total: number }> {
  const [projects, [count]] = await readSet(db, connected.bind(limit), connectedCount.bind());
  return { projects, total: count?.count ?? 0 };
}

/** Up to `limit` live Projects with no repository, by name. */
export async function unconnectedProjects(db: RelationalStore, limit: number): Promise<UnconnectedProject[]> {
  const [projects] = await readSet(db, unconnected.bind(limit));
  return projects;
}
