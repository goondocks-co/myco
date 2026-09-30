import { Navigate, Route, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { SessionPage } from '../features/sessions/SessionPage';
import { SessionsPage } from '../features/sessions/SessionsPage';
import { isRawSection } from '../features/sessions/RawData';
import { planPagePath } from '../hooks/use-knowledge';
import { NotFound } from '../pages/NotFound';
import { useRouteProject } from './route-project';

/**
 * The Sessions routes: the table across every project at `/sessions`, narrowed
 * to one at `/p/:projectId/sessions`, and a session's reading page. A link that
 * names the transcript, the context or the attachments as a tab (`?tab=`) is
 * sent to the raw data at the foot of the page, open at that part (`?raw=`),
 * and one naming a plan (`?tab=plans&plan=`) to that plan's page.
 */
export const sessionRoutes = (
  <>
    <Route path="/sessions" element={<SessionsRoute />} />
    <Route path="/p/:projectId/sessions" element={<SessionsRoute />} />
    <Route path="/p/:projectId/sessions/:sessionId" element={<SessionRoute />} />
  </>
);

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
  const plan = params.get('plan');
  if (tab === 'plans' && plan !== null && plan !== '') return <Navigate to={planPagePath(projectId, { planKey: plan })} replace />;
  if (isRawSection(tab)) {
    const moved = new URLSearchParams(params);
    moved.delete('tab');
    moved.set('raw', tab);
    return <Navigate to={`${pathname}?${moved}`} replace />;
  }
  return <SessionPage key={`${projectId}/${sessionId}`} projectId={projectId} sessionId={sessionId} projectName={projectName(projectId)} />;
}
