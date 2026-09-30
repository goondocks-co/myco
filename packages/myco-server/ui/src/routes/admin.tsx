import { Route } from 'react-router-dom';
import { AdminOnly } from '../features/admin/AdminFrame';
import { HealthPage } from '../features/admin/health/HealthPage';
import { MyMachinesPage } from '../features/admin/people/MyMachinesPage';
import { PeoplePage } from '../features/admin/people/PeoplePage';
import { ProjectSettingsPage } from '../features/admin/project/ProjectSettingsPage';
import { SettingsPage } from '../features/admin/settings/SettingsPage';
import { NotFound } from '../pages/NotFound';
import {
  HEALTH_PATH, MY_MACHINES_PATH, PEOPLE_PATH, PROJECT_SETTINGS_SUFFIX, SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './nav';
import { useRouteProject } from './route-project';

/**
 * The admin pages: People & machines, Settings in its five sections, a
 * project's settings and Health, each shown to a member who is not an admin as
 * a page for an admin; and My machines, for every member.
 * The addresses these pages replaced are in `routes/moved.tsx`.
 */
export const adminRoutes = (
  <>
    <Route path={PEOPLE_PATH} element={<AdminOnly title="People & machines"><PeoplePage /></AdminOnly>} />
    <Route path={MY_MACHINES_PATH} element={<MyMachinesPage />} />
    {SETTINGS_SECTIONS.map((section) => (
      <Route key={section.id} path={section.to} element={<SettingsRoute section={section.id} />} />
    ))}
    <Route path={`/p/:projectId${PROJECT_SETTINGS_SUFFIX}`} element={<ProjectSettingsRoute />} />
    <Route path={HEALTH_PATH} element={<AdminOnly title="Health"><HealthPage /></AdminOnly>} />
  </>
);

function SettingsRoute({ section }: { section: SettingsSectionId }) {
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
