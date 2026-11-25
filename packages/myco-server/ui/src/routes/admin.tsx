import { adminRoutesPaths, routeGroup } from './declarations';
import type { RouteObject } from 'react-router-dom';
import { AdminOnly } from '../features/admin/AdminFrame';
import { HealthPage } from '../features/admin/health/HealthPage';
import { RunnersPage } from '../features/admin/runners/RunnersPage';
import { RunnerPage } from '../features/admin/runners/RunnerPage';
import { RunsPage } from '../features/runs/RunsPage';
import { MachinePage, RunnerMachinePage } from '../features/admin/machine/MachinePage';
import { ProjectSettingsPage } from '../features/admin/project/ProjectSettingsPage';
import { SettingsPage, useSettingsRedirect } from '../features/admin/settings/SettingsPage';
import { Navigate } from 'react-router-dom';
import { NotFound } from '../pages/NotFound';
import {
  MOVED_SETTINGS_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './nav';
import { useRouteProject } from './route-project';

/**
 * Settings › People and machines and each machine's page are read by every member, each reading what the server lets
 * them see; the other Settings sections, a project's settings and Health require an admin. An older Settings,
 * People & machines or My machines address leads to where its part lives now before the admin check, so every reader
 * lands on the current page.
 */
export const adminRoutes: RouteObject[] = routeGroup(adminRoutesPaths, {
  runs: <RunsPage />,
  runners: <RunnersPage />,
  runner: <RunnerPage />,
  machine: <MachinePage />,
  runnerMachine: <RunnerMachinePage />,
  projectSettings: <ProjectSettingsRoute />,
  health: <AdminOnly title="Health"><HealthPage /></AdminOnly>,
}).concat(
  SETTINGS_SECTIONS.map((section) => ({ path: section.to, element: <SettingsRoute section={section.id} /> })),
  MOVED_SETTINGS_SECTIONS.map((section) => ({ path: section.from, element: <SettingsRoute section={section.to} /> })),
);

function SettingsRoute({ section }: { section: SettingsSectionId }) {
  const moved = useSettingsRedirect();
  if (moved !== null) return <Navigate to={moved} replace />;
  if (section === 'people') return <SettingsPage section={section} />;
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
