import type { NeedsYouProps } from '../features/today/NeedsYou';
import { useRef } from 'react';
import type { MaintenanceOutcome } from '../features/admin/health/wire';
import { backupFailedItems, backupUnchecked, SERVER_READS, storedKeyItems, storeCheckItems, type ServerItemsRead } from '../features/today/server-items';
import { isArchived } from '../lib/api';
import { useAttention } from './use-attention';
import { useHeldRead } from './use-held-read';
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
  const statusQuery = useStatus({ enabled });
  const maintenanceQuery = useMaintenance({ enabled });
  const recoveryQuery = useRecovery({ enabled });
  const status = useHeldRead(statusQuery);
  const maintenance = useHeldRead(maintenanceQuery);
  const recovery = useHeldRead(recoveryQuery);
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
      ...(maintenance.data === undefined && maintenance.pending ? [SERVER_READS.storeChecks] : []),
      ...(status.data === undefined && status.pending ? [SERVER_READS.storedKeys] : []),
      ...(recovery.data === undefined && recovery.pending ? [SERVER_READS.backups] : []),
    ],
    unchecked: [
      ...(maintenance.error === null ? [] : [SERVER_READS.storeChecks]),
      ...(keysUnread ? [SERVER_READS.storedKeys] : []),
      ...(recovery.error !== null || backupUnchecked(recovery.data) ? [SERVER_READS.backups] : []),
    ],
    refetch: () => { void statusQuery.refetch(); void maintenanceQuery.refetch(); void recoveryQuery.refetch(); },
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
  const attentionQuery = useAttention({ enabled: admin });
  const attention = useHeldRead(attentionQuery);
  const server = useServerItems({ enabled: admin });
  const repositoriesQuery = useUncaptured({ enabled: signedIn });
  const repositories = useHeldRead(repositoriesQuery);
  const projects = useProjects();
  return {
    admin,
    answer: attention.data,
    pending: attention.pending,
    error: attention.error,
    onRetry: () => {
      if (admin) { void attentionQuery.refetch(); server.refetch(); }
      if (signedIn) void repositoriesQuery.refetch();
    },
    repositories: { items: repositories.data?.items, pending: signedIn && repositories.pending, error: repositories.error },
    server,
    viewerId: me.data?.member?.id ?? null,
    projects: (projects.data?.projects ?? []).filter((p) => !isArchived(p)).map((p) => ({ projectId: p.projectId, name: p.name })),
    now,
    projectName,
  };
}
