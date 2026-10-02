import { useGrants } from './access-keys';
import { AccessKeys } from './AccessKeys';
import { Capabilities } from './Capabilities';
import { ReleaseTracking } from './ReleaseTracking';
import { Repository } from './Repository';
import { useReleaseProvenance } from '../../../hooks/use-release-provenance';
import { useCapabilities, useRepository } from '../../../hooks/use-settings';
import { AdminPage, useAnchorScroll } from '../AdminFrame';

/**
 * `/p/:project/settings`: what Myco does in one project, the repository its
 * code tasks read, the keys agents outside this server read it with, and
 * release tracking. A link to one part (`#access-keys`) lands there once every
 * part above it has been read.
 */
export function ProjectSettingsPage({ projectId, projectName }: { projectId: string; projectName: string | null }) {
  const settled = [useCapabilities(projectId), useRepository(projectId), useGrants(projectId), useReleaseProvenance(projectId)].every((q) => !q.isPending);
  useAnchorScroll(settled);
  return (
    <AdminPage
      name="project-settings"
      scope="project"
      title="Project settings"
      lede={`How Myco works in ${projectName ?? 'this project'}: what it does there, the repository it reads, who outside this server may read it, and whether its work has shipped.`}
    >
      <Capabilities projectId={projectId} />
      <Repository projectId={projectId} />
      <AccessKeys projectId={projectId} />
      <ReleaseTracking projectId={projectId} />
    </AdminPage>
  );
}
