import { useParams, type RouteObject } from 'react-router-dom';
import { TasksPage } from '../features/tasks/TasksPage';
import { WorkPage } from '../features/work/WorkPage';
import { RUN_SUFFIX, TASKS_SUFFIX, WORK_SUFFIX } from './nav';
import { useRouteProject } from './route-project';

/**
 * Myco's work across every project at `/work`, narrowed to one at
 * `/p/:projectId/work`, and one run in its panel over that project's work at
 * `/p/:projectId/work/runs/:runId`. The Agent runs addresses that lead here
 * are in `routes/moved.tsx`.
 */
export const workRoutes: RouteObject[] = [
  { path: TASKS_SUFFIX, element: <TasksRoute /> },
  { path: `/p/:projectId${TASKS_SUFFIX}`, element: <TasksRoute /> },
  { path: WORK_SUFFIX, element: <WorkRoute /> },
  { path: `/p/:projectId${WORK_SUFFIX}`, element: <WorkRoute /> },
  { path: `/p/:projectId${RUN_SUFFIX}/:runId`, element: <WorkRoute /> },
];

function WorkRoute() {
  const { runId } = useParams();
  const { projectId, standIn, projectName } = useRouteProject();
  if (standIn !== null) return standIn;
  return <WorkPage key={projectId ?? ''} projectId={projectId} projectName={projectName} runId={runId ?? null} />;
}

function TasksRoute() {
  const { projectId, standIn } = useRouteProject();
  if (standIn !== null) return standIn;
  return <TasksPage key={projectId ?? ''} projectId={projectId} />;
}
