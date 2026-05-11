import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';

export interface CreateGroveResponse {
  id: string;
  slug: string;
  name: string;
  mode: 'local';
  created_at: string;
}

export interface RenameGroveResponse {
  id: string;
  slug: string;
  name: string;
}

export interface MoveProjectResponse {
  ok: boolean;
  move: Record<string, unknown>;
}

export interface BackupProjectResponse {
  ok: boolean;
  snapshot_path: string;
  size_bytes: number;
}

export interface SetDefaultGroveResponse {
  id: string;
  slug: string;
  name: string;
  is_default: true;
}

export function useCreateGrove() {
  const qc = useQueryClient();
  return useMutation<CreateGroveResponse, Error, { name: string }>({
    mutationFn: (body) => postJson<CreateGroveResponse>('/groves', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useRenameGrove() {
  const qc = useQueryClient();
  return useMutation<RenameGroveResponse, Error, { id: string; name: string }>({
    mutationFn: ({ id, name }) =>
      fetchJson<RenameGroveResponse>(`/groves/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['groves'] });
      qc.invalidateQueries({ queryKey: ['grove', variables.id] });
    },
  });
}

export function useDeleteGrove() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string }>({
    mutationFn: ({ id }) =>
      fetchJson<void>(`/groves/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useMoveProject() {
  const qc = useQueryClient();
  return useMutation<
    MoveProjectResponse,
    Error,
    { targetGroveId: string; projectId: string }
  >({
    mutationFn: ({ targetGroveId, projectId }) =>
      postJson<MoveProjectResponse>(
        `/groves/${encodeURIComponent(targetGroveId)}/projects/${encodeURIComponent(projectId)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useSetDefaultGrove() {
  const qc = useQueryClient();
  return useMutation<SetDefaultGroveResponse, Error, { id: string }>({
    mutationFn: ({ id }) =>
      postJson<SetDefaultGroveResponse>(`/groves/${encodeURIComponent(id)}/default`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useBackupProject() {
  return useMutation<BackupProjectResponse, Error, { projectId: string }>({
    mutationFn: ({ projectId }) =>
      postJson<BackupProjectResponse>(
        `/projects/${encodeURIComponent(projectId)}/backup`,
      ),
  });
}
