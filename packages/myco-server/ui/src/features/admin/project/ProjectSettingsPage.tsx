import { AdminPage } from '../AdminFrame';

/** `/p/:project/settings`: what Myco does in one project, its repository, its access keys and release tracking. */
export function ProjectSettingsPage({ projectId, projectName }: { projectId: string; projectName: string | null }) {
  return <AdminPage name="project-settings" title="Project settings" lede={projectName ?? projectId}>{null}</AdminPage>;
}
