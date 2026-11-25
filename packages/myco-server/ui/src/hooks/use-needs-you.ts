import type { NeedsYouProps } from '../features/today/NeedsYou';
import { backupFailedItems, storedKeyItems, storeCheckItems, type ServerItemsRead } from '../features/today/server-items';
import { ApiError, isArchived } from '../lib/api';
import { useAttention } from './use-attention';
import { useMaintenance } from './use-maintenance';
import { permissionOf, useMe } from './use-me';
import { useProjects } from './use-projects';
import { useRecovery } from './use-recovery';
import { useStatus } from './use-status';
import { useUncaptured } from './use-uncaptured';

/** A server that runs no automatic backup answers its read with a refusal: there is nothing to ask about, not a failed read. */
const noProducer = (error: unknown): boolean => error instanceof ApiError && error.status === 400;

/**
 * What needs an admin beside the attention answer: store checks that found a problem, stored keys that were rejected,
 * and a failed automatic backup. A read that failed is named, so its silence is never taken for all clear.
 */
export function useServerItems({ enabled }: { enabled: boolean }): ServerItemsRead & { refetch: () => void } {
  const status = useStatus({ enabled });
  const maintenance = useMaintenance({ enabled });
  const recovery = useRecovery({ enabled });
  const recoveryFailed = recovery.error !== null && !noProducer(recovery.error);
  return {
    items: enabled ? [
      ...storeCheckItems(maintenance.error === null ? maintenance.data : undefined),
      ...storedKeyItems(status.error === null ? status.data : undefined),
      ...backupFailedItems(recovery.error === null ? recovery.data : undefined),
    ] : [],
    pending: enabled && (status.isPending || maintenance.isPending || (recovery.isPending && recovery.error === null)),
    unchecked: enabled ? [
      ...(maintenance.error === null ? [] : ['store checks']),
      ...(status.error === null ? [] : ['stored keys']),
      ...(recoveryFailed ? ['automatic backups'] : []),
    ] : [],
    refetch: () => { void status.refetch(); void maintenance.refetch(); void recovery.refetch(); },
  };
}

/**
 * What "Needs you" reads: for an admin, the server's own health; for every viewer, the repositories their machines
 * are not capturing yet (an admin's, every machine's), with the projects one can be connected to.
 */
export function useNeedsYou({ now, projectName }: { now: number; projectName: (projectId: string) => string | null }): NeedsYouProps {
  const me = useMe();
  const signedIn = me.data?.member != null;
  const admin = permissionOf(me.data, 'settings').allowed;
  const attention = useAttention({ enabled: admin });
  const server = useServerItems({ enabled: admin });
  const repositories = useUncaptured({ enabled: signedIn });
  const projects = useProjects();
  return {
    admin,
    answer: attention.data,
    pending: attention.isPending,
    error: attention.error,
    onRetry: () => {
      if (admin) { void attention.refetch(); server.refetch(); }
      if (signedIn) void repositories.refetch();
    },
    repositories: { items: repositories.data?.items, pending: signedIn && repositories.isPending, error: repositories.error },
    server,
    viewerId: me.data?.member?.id ?? null,
    projects: (projects.data?.projects ?? []).filter((p) => !isArchived(p)).map((p) => ({ projectId: p.projectId, name: p.name })),
    now,
    projectName,
  };
}
