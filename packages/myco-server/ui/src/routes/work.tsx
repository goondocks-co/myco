import { Route, useParams } from 'react-router-dom';
import { WorkPage } from '../features/work/WorkPage';
import { NotFound } from '../pages/NotFound';
import { RUN_SUFFIX, WORK_SUFFIX } from './nav';
import { useRouteProject } from './route-project';

/**
 * Myco's work across every project at `/work`, narrowed to one at
 * `/p/:projectId/work`, and one run in its panel over that project's work at
 * `/p/:projectId/work/runs/:runId`. The Agent runs addresses that lead here
 * are in `routes/moved.tsx`.
 */
export const workRoutes = (
  <>
    <Route path={WORK_SUFFIX} element={<WorkRoute />} />
    <Route path={`/p/:projectId${WORK_SUFFIX}`} element={<WorkRoute />} />
    <Route path={`/p/:projectId${RUN_SUFFIX}/:runId`} element={<WorkRoute />} />
  </>
);

function WorkRoute() {
  const { runId } = useParams();
  const { projectId, known, projectName } = useRouteProject();
  if (!known) return <NotFound />;
  return <WorkPage key={projectId ?? ''} projectId={projectId} projectName={projectName} runId={runId ?? null} />;
}
