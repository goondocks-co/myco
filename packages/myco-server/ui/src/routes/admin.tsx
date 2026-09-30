import { Navigate, Route, useLocation, useParams } from 'react-router-dom';
import { AdminOnly } from '../features/admin/AdminFrame';
import { HealthPage } from '../features/admin/health/HealthPage';
import { MyMachinesPage } from '../features/admin/people/MyMachinesPage';
import { PeoplePage } from '../features/admin/people/PeoplePage';
import { ProjectSettingsPage } from '../features/admin/project/ProjectSettingsPage';
import { SettingsPage } from '../features/admin/settings/SettingsPage';
import { useIsAdmin } from '../hooks/use-me';
import { NotFound } from '../pages/NotFound';
import {
  HEALTH_ANCHORS, HEALTH_PATH, MY_MACHINES_PATH, PEOPLE_PATH, PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath, SETTINGS_SECTIONS,
  type SettingsSectionId,
} from './nav';
import { useRouteProject } from './route-project';

/**
 * The admin pages: People & machines, Settings in its five sections, a
 * project's settings and Health, each shown to a member who is not an admin as
 * a page for an admin; and My machines, for every member.
 *
 * The addresses these pages replaced lead to them: `/access` to People &
 * machines (a member's to My machines), a project's `/access` to its access
 * keys, and `/status`, `/measures` and `/operations` to their part of Health.
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
    <Route path="/access" element={<AccessMoved />} />
    <Route path="/p/:projectId/access" element={<ProjectAccessMoved />} />
    <Route path="/status" element={<HealthMoved anchor={HEALTH_ANCHORS.status} />} />
    <Route path="/measures" element={<HealthMoved anchor={HEALTH_ANCHORS.measures} />} />
    <Route path="/operations" element={<HealthMoved anchor={HEALTH_ANCHORS.upkeep} />} />
  </>
);

function SettingsRoute({ section }: { section: SettingsSectionId }) {
  return <AdminOnly title="Settings"><SettingsPage section={section} /></AdminOnly>;
}

function ProjectSettingsRoute() {
  const { projectId, known, projectName } = useRouteProject();
  if (!known || projectId === null) return <NotFound />;
  return (
    <AdminOnly title="Project settings">
      <ProjectSettingsPage key={projectId} projectId={projectId} projectName={projectName(projectId)} />
    </AdminOnly>
  );
}

/** `/access` was the members page, and a member's list of their own machines: each goes to the page that holds it now. */
function AccessMoved() {
  return <Navigate to={useIsAdmin() ? PEOPLE_PATH : MY_MACHINES_PATH} replace />;
}

/** A project's `/access` held its access keys, which are part of its settings now. */
function ProjectAccessMoved() {
  const { projectId = '' } = useParams();
  return <Navigate to={`${projectPath(projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}`} replace />;
}

/** Status, Measures and Operations are parts of Health; the query string (a measures window) is kept. */
function HealthMoved({ anchor }: { anchor: string }) {
  const { search } = useLocation();
  return <Navigate to={`${HEALTH_PATH}${search}#${anchor}`} replace />;
}
