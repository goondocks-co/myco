import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useProjects } from '../hooks/use-projects';
import { forgetProject } from '../lib/project-memory';

/**
 * The project a route names, and every project's name. `known` is false once
 * the projects are read and none has that id, so the page says not found
 * rather than showing an empty list; the nav then forgets that project.
 */
export function useRouteProject() {
  const { projectId } = useParams();
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const known = projectId === undefined || projects.data === undefined || names.has(projectId);
  useEffect(() => { if (!known) forgetProject(); }, [known]);
  return { projectId: projectId ?? null, known, projectName: (id: string): string | null => names.get(id) ?? null };
}
