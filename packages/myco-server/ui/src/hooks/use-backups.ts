import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { BackupsAnswer, BackupVerification, CreateBackupAnswer, RestoreAnswer, RestoreJob, RestorePreview } from '../features/admin/health/wire';
import { live } from '../lib/live';

export type { BackupRow, RestoreJob, RestoreOutcome, RestorePreview } from '../features/admin/health/wire';

/** The Deployment's backups: the paged list, a new one, pinning, checking one, and a restore previewed before it runs. */
export function useBackups() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['backups'] }); };
  return {
    list: useInfiniteQuery({
      queryKey: ['backups'],
      initialPageParam: null as string | null,
      queryFn: ({ signal, pageParam }) => fetchJson<BackupsAnswer>(pageParam === null ? '/api/backups' : `/api/backups?cursor=${encodeURIComponent(pageParam)}`, signal),
      getNextPageParam: (page) => page.cursor,
      ...live({ follows: ['recovery'] }),
    }),
    create: useMutation({ mutationFn: () => postJson<CreateBackupAnswer>('/api/backups', {}), onSuccess: invalidate }),
    pin: useMutation({ mutationFn: (v: { id: string; pinned: boolean }) => postJson<{ pinned: boolean }>(`/api/backups/${encodeURIComponent(v.id)}/pin`, { pinned: v.pinned }), onSuccess: invalidate }),
    verify: useMutation({ mutationFn: (id: string) => postJson<{ verification: BackupVerification }>(`/api/backups/${encodeURIComponent(id)}/verify`, {}), onSuccess: invalidate }),
    preview: useMutation({ mutationFn: (id: string) => postJson<RestorePreview>(`/api/backups/${encodeURIComponent(id)}/restore-preview`, {}) }),
    restore: useMutation({
      mutationFn: (v: { id: string; allowForeignLineage?: boolean }) =>
        postJson<RestoreAnswer>(`/api/backups/${encodeURIComponent(v.id)}/restore`, v.allowForeignLineage === true ? { allowForeignLineage: true } : {}),
      onSettled: invalidate,
    }),
    continueRestore: useMutation({
      mutationFn: (id: string) => postJson<RestoreAnswer>(`/api/backups/restores/${encodeURIComponent(id)}/continue`, {}),
      onSettled: invalidate,
    }),
    stopRestore: useMutation({
      mutationFn: (id: string) => postJson<{ job: RestoreJob }>(`/api/backups/restores/${encodeURIComponent(id)}/stop`, {}),
      onSettled: invalidate,
    }),
  };
}

/** One restore's progress, read again while the server is still walking it. */
export function useRestoreJob(id: string | null) {
  return useQuery({
    queryKey: ['backups', 'restore', id],
    enabled: id !== null,
    queryFn: ({ signal }) => fetchJson<{ job: RestoreJob }>(`/api/backups/restores/${encodeURIComponent(id!)}`, signal),
    ...live({ whileMoving: (data: { job: RestoreJob } | undefined) => data?.job.state === 'running' }),
  });
}
