import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, deleteJson, fetchJson, putJson } from '../lib/api';

export interface LeafRow {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface SecretRow {
  name: string;
  configured: boolean;
  readable: boolean;
  maskedValue: string | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

export type Capabilities = Record<string, boolean>;

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => fetchJson<{ leaves: LeafRow[] }>('/api/settings', signal) });
}

export function useSecrets() {
  return useQuery({ queryKey: ['secrets'], queryFn: ({ signal }) => fetchJson<{ secrets: SecretRow[] }>('/api/secrets', signal) });
}

export function useCapabilities(projectId: string) {
  return useQuery({
    queryKey: ['capabilities', projectId],
    queryFn: ({ signal }) => fetchJson<{ capabilities: Capabilities }>(`/api/projects/${encodeURIComponent(projectId)}/capabilities`, signal),
  });
}

/** What the server said when it refused a settings change, in the person's words. */
export function settingsRefusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { reason?: unknown; detail?: unknown } | null;
    switch (body?.reason) {
      case 'not_deployment_tier':
        return 'That setting is not held by the server.';
      case 'malformed':
        return typeof body?.detail === 'string' ? body.detail : 'The server could not read that value.';
      case 'unknown_capability':
        return 'The server does not know that capability.';
      default:
        return `The server refused (${err.status}).`;
    }
  }
  return 'Could not reach the server.';
}

/** One mutation per settings act. A mutation that carries a secret keeps no copy once it has answered. */
export function useSettingsActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    setLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string; value: unknown }) => putJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, { value: v.value }),
      onSuccess: () => refresh('settings'),
    }),
    setSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string; value: string }) => putJson<SecretRow>(`/api/secrets/${encodeURIComponent(v.name)}`, { value: v.value }),
      onSuccess: () => refresh('secrets'),
    }),
    deleteSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string }) => deleteJson<{ deleted: boolean }>(`/api/secrets/${encodeURIComponent(v.name)}`),
      onSuccess: () => refresh('secrets'),
    }),
    setCapability: useMutation({
      mutationFn: (v: { projectId: string; capability: string; enabled: boolean }) =>
        putJson<{ applied: true }>(`/api/projects/${encodeURIComponent(v.projectId)}/capabilities/${encodeURIComponent(v.capability)}`, { enabled: v.enabled }),
      onSuccess: () => refresh('capabilities'),
    }),
  };
}
