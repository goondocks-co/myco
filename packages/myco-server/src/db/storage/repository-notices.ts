import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { capabilityExplicitlyOnSql, capabilityOnSql } from '../settings/admission.js';

/** A capability a Project's code work needs, and whether a code schedule currently enables it. */
interface CodeRequest { capability: string; scheduled: boolean }

const SELECT = (projects: string) => `SELECT p.project_id AS projectId FROM projects p
    WHERE ${projects} AND p.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_repositories r WHERE r.project_id = p.project_id)
      AND EXISTS (SELECT 1 FROM json_each(?1) requested
        WHERE ${capabilityExplicitlyOnSql('p.project_id', "json_extract(requested.value, '$.capability')")}
        OR (json_extract(requested.value, '$.scheduled') = 1
          AND ${capabilityOnSql('p.project_id', "json_extract(requested.value, '$.capability')")}))
    ORDER BY p.project_id LIMIT ?2`;

/** Every Project accepting capture. */
const everyProject = read<[requests: string, limit: number], { projectId: string }>({ name: 'repositoryNotices.all', sql:
  SELECT('p.project_id IN (SELECT project_id FROM projects WHERE archived_at IS NULL)') });
const namedProjects = read<[requests: string, limit: number, projects: string], { projectId: string }>({ name: 'repositoryNotices.named', sql:
  SELECT('p.project_id IN (SELECT value FROM json_each(?3))') });

/** Up to `limit` Projects in the set with no repository whose requested capabilities are explicitly on, or scheduled and effectively on. */
export async function projectsNeedingRepository(db: RelationalStore, request: { requests: readonly CodeRequest[]; projects: 'all' | readonly string[]; limit: number }): Promise<string[]> {
  const requests = JSON.stringify(request.requests);
  const [rows] = await readSet(db, request.projects === 'all' ? everyProject.bind(requests, request.limit)
    : namedProjects.bind(requests, request.limit, JSON.stringify(request.projects)));
  return rows.map(row => row.projectId);
}
