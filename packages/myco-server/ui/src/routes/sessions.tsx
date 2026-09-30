import { useEffect } from 'react';
import { Navigate, Route, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { SessionPage } from '../features/sessions/SessionPage';
import { SessionsPage } from '../features/sessions/SessionsPage';
import { isRawSection } from '../features/sessions/RawData';
import { useProjects } from '../hooks/use-projects';
import { forgetProject } from '../lib/project-memory';
import { NotFound } from '../pages/NotFound';

/**
 * The Sessions routes: the table across every project at `/sessions`, narrowed
 * to one at `/p/:projectId/sessions`, and a session's reading page. A link that
 * names the transcript, the context or the attachments as a tab (`?tab=`) is
 * sent to the raw data at the foot of the page, open at that part (`?raw=`).
 */
export const sessionRoutes = (
  <>
    <Route path="/sessions" element={<SessionsRoute />} />
    <Route path="/p/:projectId/sessions" element={<SessionsRoute />} />
    <Route path="/p/:projectId/sessions/:sessionId" element={<SessionRoute />} />
  </>
);

/** The project a route names, and its name; `known` is false once the projects are read and none has that id. */
function useRouteProject() {
  const { projectId } = useParams();
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const known = projectId === undefined || projects.data === undefined || names.has(projectId);
  useEffect(() => { if (!known) forgetProject(); }, [known]);
  return { projectId: projectId ?? null, known, projectName: (id: string): string | null => names.get(id) ?? null };
}

function SessionsRoute() {
  const { projectId, known, projectName } = useRouteProject();
  if (!known) return <NotFound />;
  return <SessionsPage key={projectId ?? ''} projectId={projectId} projectName={projectName} />;
}

function SessionRoute() {
  const { sessionId = '' } = useParams();
  const { projectId, known, projectName } = useRouteProject();
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  if (!known || projectId === null) return <NotFound />;
  const tab = params.get('tab');
  if (isRawSection(tab)) {
    const moved = new URLSearchParams(params);
    moved.delete('tab');
    moved.set('raw', tab);
    return <Navigate to={`${pathname}?${moved}`} replace />;
  }
  return <SessionPage key={`${projectId}/${sessionId}`} projectId={projectId} sessionId={sessionId} projectName={projectName(projectId)} />;
}
