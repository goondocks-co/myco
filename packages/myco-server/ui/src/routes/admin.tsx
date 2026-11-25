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
import { healthAddress, SettingsPage, useSettingsRedirect } from '../features/admin/settings/SettingsPage';
import { ADVANCED_ANCHORS } from '../features/admin/settings/AdvancedGroups';
import { Navigate, useLocation } from 'react-router-dom';
import { NotFound } from '../pages/NotFound';
import {
  MOVED_SETTINGS_SECTIONS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  anchorOf,
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
  people: <PeopleRoute />,
  machines: <MyMachinesPage />,
  projectSettings: <ProjectSettingsRoute />,
  health: <HealthRoute />,
}).concat(
  SETTINGS_SECTIONS.map((section) => ({ path: section.to, element: <SettingsRoute section={section.id} /> })),
  MOVED_SETTINGS_SECTIONS.map((section) => ({ path: section.from, element: <SettingsRoute section={section.to} /> })),
);

/** Parts of People & machines that moved to Settings › Advanced, where a bookmark to them leads now. */
const MOVED_FROM_PEOPLE = new Set(ADVANCED_ANCHORS.filter(([, fold]) => fold === 'owner-actions').map(([anchor]) => anchor));

function PeopleRoute() {
  const { hash } = useLocation();
  const anchor = anchorOf(hash);
  if (MOVED_FROM_PEOPLE.has(anchor)) return <Navigate to={`${SETTINGS_SECTIONS.find((section) => section.id === 'advanced')!.to}#${anchor}`} replace />;
  return <PeoplePage />;
}

/** Health, or the place a part that left it lives now when a link names that part's old anchor. */
function HealthRoute() {
  const { search, hash } = useLocation();
  const moved = healthAddress(search, hash);
  if (moved !== null) return <Navigate to={moved} replace />;
  return <AdminOnly title="Health"><HealthPage /></AdminOnly>;
}

function SettingsRoute({ section }: { section: SettingsSectionId }) {
  const moved = useSettingsRedirect();
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
