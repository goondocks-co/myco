import type { NeedsYouProps } from '../features/today/NeedsYou';
import { useRef } from 'react';
import type { MaintenanceOutcome } from '../features/admin/health/wire';
import { backupFailedItems, backupUnchecked, storedKeyItems, storeCheckItems, type ServerItemsRead } from '../features/today/server-items';
import { isArchived } from '../lib/api';
import { useAttention } from './use-attention';
import { useMaintenance } from './use-maintenance';
import { permissionOf, useMe } from './use-me';
import { useProjects } from './use-projects';
import { useRecovery } from './use-recovery';
import { useStatus } from './use-status';
import { useUncaptured } from './use-uncaptured';

/**
 * What needs an admin beside the attention answer: store checks that found a problem, stored keys that were rejected,
 * and a failed automatic backup. A failed refresh keeps what was read and names the read; a store check's finding
 * stays while a new run of it is under way.
 */
export function useServerItems({ enabled }: { enabled: boolean }): ServerItemsRead & { refetch: () => void } {
  const status = useStatus({ enabled });
  const maintenance = useMaintenance({ enabled });
  const recovery = useRecovery({ enabled });
  const findings = useRef(new Map<string, MaintenanceOutcome>());
  for (const check of maintenance.data?.checks ?? []) {
    if (check.running) continue;
    if (check.latest?.state === 'findings' || check.latest?.state === 'failed') findings.current.set(check.check, check.latest);
    else findings.current.delete(check.check);
  }
  if (!enabled) return { items: [], checking: [], unchecked: [], refetch: () => undefined };
  const keysUnread = status.error !== null || status.data?.unavailable?.includes('workers') === true;
  return {
    items: [
      ...storeCheckItems(maintenance.data, findings.current),
      ...storedKeyItems(status.data),
      ...backupFailedItems(recovery.data),
    ],
    checking: [
      ...(maintenance.data === undefined && maintenance.isPending ? ['store checks'] : []),
      ...(status.data === undefined && status.isPending ? ['stored keys'] : []),
      ...(recovery.data === undefined && recovery.isPending ? ['automatic backups'] : []),
    ],
    unchecked: [
      ...(maintenance.error === null ? [] : ['store checks']),
      ...(keysUnread ? ['stored keys'] : []),
      ...(recovery.error !== null || backupUnchecked(recovery.data) ? ['automatic backups'] : []),
    ],
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
