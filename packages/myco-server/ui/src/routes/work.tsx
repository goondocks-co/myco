import { Navigate, Route, useLocation, useParams } from 'react-router-dom';
import { WorkPage } from '../features/work/WorkPage';
import { NotFound } from '../pages/NotFound';
import { projectPath, RUN_SUFFIX, WORK_SUFFIX } from './nav';
import { useRouteProject } from './route-project';

/**
 * Myco's work across every project at `/work`, narrowed to one at
 * `/p/:projectId/work`, and one run in its panel over that project's work at
 * `/p/:projectId/work/runs/:runId`. The Agent runs addresses lead to the same
 * places, the query kept.
 */
export const workRoutes = (
  <>
    <Route path={WORK_SUFFIX} element={<WorkRoute />} />
    <Route path={`/p/:projectId${WORK_SUFFIX}`} element={<WorkRoute />} />
    <Route path={`/p/:projectId${RUN_SUFFIX}/:runId`} element={<WorkRoute />} />
    <Route path="/p/:projectId/runs" element={<MovedRun />} />
    <Route path="/p/:projectId/runs/:runId" element={<MovedRun />} />
  </>
);

function WorkRoute() {
  const { runId } = useParams();
  const { projectId, known, projectName } = useRouteProject();
  if (!known) return <NotFound />;
  return <WorkPage key={projectId ?? ''} projectId={projectId} projectName={projectName} runId={runId ?? null} />;
}

/** An Agent runs address, sent to Myco's work under the same project, with the run's panel open when it names one. */
function MovedRun() {
  const { projectId = '', runId } = useParams();
  const { search } = useLocation();
  const to = runId === undefined ? projectPath(projectId, WORK_SUFFIX) : projectPath(projectId, `${RUN_SUFFIX}/${encodeURIComponent(runId)}`);
  return <Navigate to={`${to}${search}`} replace />;
}
