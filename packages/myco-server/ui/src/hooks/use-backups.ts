import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';

export interface BackupRow {
  id: string;
  key: string;
  created_at: number;
  size_bytes: number;
  counts_json: string;
  schema_version: number;
  producer: string;
  pinned: number;
  /** Whether the artifact is actually in the object store; an index row whose object vanished renders broken. */
  present: boolean;
}

export interface RestorePreview {
  header: { deploymentId: string; schemaVersion: number; createdAt: number; producer: string; counts: Record<string, number> };
  foreignLineage: boolean;
}

export interface RestoreOutcome {
  applied: boolean;
  tables: Record<string, { rows: number; inserted: number; skipped?: string }>;
}

export function useBackups() {
  const qc = useQueryClient();
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['backups'] }); };
  return {
    list: useQuery({ queryKey: ['backups'], queryFn: ({ signal }) => fetchJson<{ backups: BackupRow[] }>('/api/backups', signal) }),
    create: useMutation({ mutationFn: () => postJson<{ backup: BackupRow; pruned: number }>('/api/backups', {}), onSuccess: invalidate }),
    pin: useMutation({ mutationFn: (v: { id: string; pinned: boolean }) => postJson<{ pinned: boolean }>(`/api/backups/${v.id}/pin`, { pinned: v.pinned }), onSuccess: invalidate }),
    preview: (id: string) => postJson<RestorePreview>(`/api/backups/${id}/restore-preview`, {}),
    restore: useMutation({
      mutationFn: (v: { id: string; allowForeignLineage?: boolean }) =>
        postJson<RestoreOutcome>(`/api/backups/${v.id}/restore`, v.allowForeignLineage === true ? { allowForeignLineage: true } : {}),
      onSuccess: invalidate,
    }),
  };
}
