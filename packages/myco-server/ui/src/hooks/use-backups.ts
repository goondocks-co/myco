import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { BackupRow, BackupsAnswer, RestoreOutcome, RestorePreview } from '../features/admin/health/wire';

export type { BackupRow, RestoreOutcome, RestorePreview } from '../features/admin/health/wire';

/** The Deployment's backups: the list, a new one, pinning, and a restore previewed before it runs. */
export function useBackups() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['backups'] }); };
  return {
    list: useQuery({ queryKey: ['backups'], queryFn: ({ signal }) => fetchJson<BackupsAnswer>('/api/backups', signal) }),
    create: useMutation({ mutationFn: () => postJson<{ backup: BackupRow; pruned: number }>('/api/backups', {}), onSuccess: invalidate }),
    pin: useMutation({ mutationFn: (v: { id: string; pinned: boolean }) => postJson<{ pinned: boolean }>(`/api/backups/${encodeURIComponent(v.id)}/pin`, { pinned: v.pinned }), onSuccess: invalidate }),
    preview: useMutation({ mutationFn: (id: string) => postJson<RestorePreview>(`/api/backups/${encodeURIComponent(id)}/restore-preview`, {}) }),
    restore: useMutation({
      mutationFn: (v: { id: string; allowForeignLineage?: boolean }) =>
        postJson<RestoreOutcome>(`/api/backups/${encodeURIComponent(v.id)}/restore`, v.allowForeignLineage === true ? { allowForeignLineage: true } : {}),
      onSuccess: invalidate,
    }),
  };
}
