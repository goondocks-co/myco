import { adminRoutesPaths, routeGroup } from './declarations';
import type { RouteObject } from 'react-router-dom';
import { AdminOnly } from '../features/admin/AdminFrame';
import { HealthPage } from '../features/admin/health/HealthPage';
import { RunnersPage } from '../features/admin/runners/RunnersPage';
import { RunnerPage } from '../features/admin/runners/RunnerPage';
import { RunsPage } from '../features/runs/RunsPage';
import { MyMachinesPage } from '../features/admin/people/MyMachinesPage';
import { PeoplePage } from '../features/admin/people/PeoplePage';
import { ProjectSettingsPage } from '../features/admin/project/ProjectSettingsPage';
import { SettingsPage, useSettingsRedirect } from '../features/admin/settings/SettingsPage';
import { Navigate } from 'react-router-dom';
import { NotFound } from '../pages/NotFound';
import {
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './nav';
import { useRouteProject } from './route-project';

/**
 * People & machines shows the directory to every member. Settings in its
 * sections, a project's settings and Health require an admin; My machines is
 * available to every member. An older Settings address leads to where its part
 * lives now before the admin check, so every reader lands on the current page.
 */
export const adminRoutes: RouteObject[] = routeGroup(adminRoutesPaths, {
  runs: <RunsPage />,
  runners: <RunnersPage />,
  runner: <RunnerPage />,
  people: <PeoplePage />,
  machines: <MyMachinesPage />,
  projectSettings: <ProjectSettingsRoute />,
  health: <AdminOnly title="Health"><HealthPage /></AdminOnly>,
}).concat(SETTINGS_SECTIONS.map((section) => ({ path: section.to, element: <SettingsRoute section={section.id} /> })));

function SettingsRoute({ section }: { section: SettingsSectionId }) {
  const moved = useSettingsRedirect(section);
  if (moved !== null) return <Navigate to={moved} replace />;
  return <AdminOnly title="Settings"><SettingsPage section={section} /></AdminOnly>;
}

function ProjectSettingsRoute() {
  const { projectId, standIn, projectName } = useRouteProject();
  if (standIn !== null) return standIn;
  if (projectId === null) return <NotFound />;
  return (
    <AdminOnly title="Project settings">
      <ProjectSettingsPage key={projectId} projectId={projectId} projectName={projectName(projectId)} />
    </AdminOnly>
  );
}
