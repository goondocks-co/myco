import type { NeedsYouProps } from '../features/today/NeedsYou';
import { isArchived } from '../lib/api';
import { useAttention } from './use-attention';
import { permissionOf, useMe } from './use-me';
import { useProjects } from './use-projects';
import { useUncaptured } from './use-uncaptured';

/**
 * What "Needs you" reads: for an admin, the server's own health; for every viewer, the repositories their machines
 * are not capturing yet (an admin's, every machine's), with the projects one can be connected to.
 */
export function useNeedsYou({ now, projectName }: { now: number; projectName: (projectId: string) => string | null }): NeedsYouProps {
  const me = useMe();
  const signedIn = me.data?.member != null;
  const admin = permissionOf(me.data, 'settings').allowed;
  const attention = useAttention({ enabled: admin });
  const repositories = useUncaptured({ enabled: signedIn });
  const projects = useProjects();
  return {
    admin,
    answer: attention.data,
    pending: attention.isPending,
    error: attention.error,
    onRetry: () => void attention.refetch(),
    repositories: { items: repositories.data?.items, pending: signedIn && repositories.isPending, error: repositories.error },
    viewerId: me.data?.member?.id ?? null,
    projects: (projects.data?.projects ?? []).filter((p) => !isArchived(p)).map((p) => ({ projectId: p.projectId, name: p.name })),
    now,
    projectName,
  };
}
