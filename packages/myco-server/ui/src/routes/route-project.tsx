import { useEffect, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../design';
import { useProjects } from '../hooks/use-projects';
import { forgetProject } from '../lib/project-memory';
import { NotFound } from '../pages/NotFound';

/**
 * The project a route names, and every project's name.
 *
 * A page that spans every project starts at once, beside the projects' read.
 * A page under one project waits for that read: `standIn` is what the route
 * shows in its place until the page may render. It is a loading state while
 * the list is unread, the list's error if it failed, and Not found once the
 * list holds no project with that id, when the nav also forgets it. So a
 * project page never asks for a project that does not exist, and never shows a
 * stand-in name before the real one.
 */
export function useRouteProject(): {
  projectId: string | null;
  standIn: ReactNode | null;
  projectName: (id: string) => string | null;
} {
  const { projectId } = useParams();
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const unknown = projectId !== undefined && projects.data !== undefined && !names.has(projectId);
  useEffect(() => { if (unknown) forgetProject(); }, [unknown]);
  const standIn = projectId === undefined ? null
    : projects.isPending ? <LoadingState label="Loading the project" count={4} />
    : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
    : unknown ? <NotFound />
    : null;
  return { projectId: projectId ?? null, standIn, projectName: (id: string): string | null => names.get(id) ?? null };
}
