import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, deleteJson, fetchJson, putJson } from '../lib/api';

export interface LeafRow {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
  requiresStepUp: boolean;
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

/** The header a step-up key travels in; the server's own name for it. */
export const STEP_UP_HEADER = 'x-myco-step-up';

const withKey = (stepUpKey?: string): Record<string, string> => (stepUpKey === undefined || stepUpKey === '' ? {} : { [STEP_UP_HEADER]: stepUpKey });

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
export function settingsRefusalText(err: unknown, keyPresented: boolean): string {
  if (err instanceof ApiError) {
    const body = err.body as { reason?: unknown; detail?: unknown } | null;
    switch (body?.reason) {
      case 'unauthorized':
        return keyPresented ? 'That key did not work: it may be spent, expired, or minted for another operation.' : 'This change needs a step-up key.';
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

/** True when the refusal is the one a step-up key answers. */
export function needsStepUp(err: unknown): boolean {
  return err instanceof ApiError && (err.body as { reason?: unknown } | null)?.reason === 'unauthorized';
}

/** One mutation per settings act. A mutation that carries a secret or a key keeps no copy once it has answered. */
export function useSettingsActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    setLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string; value: unknown; stepUpKey?: string }) => putJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, { value: v.value }, withKey(v.stepUpKey)),
      onSuccess: () => refresh('settings'),
    }),
    setSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string; value: string; stepUpKey: string }) => putJson<SecretRow>(`/api/secrets/${encodeURIComponent(v.name)}`, { value: v.value }, withKey(v.stepUpKey)),
      onSuccess: () => refresh('secrets'),
    }),
    deleteSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string; stepUpKey: string }) => deleteJson<{ deleted: boolean }>(`/api/secrets/${encodeURIComponent(v.name)}`, withKey(v.stepUpKey)),
      onSuccess: () => refresh('secrets'),
    }),
    setCapability: useMutation({
      mutationFn: (v: { projectId: string; capability: string; enabled: boolean }) =>
        putJson<{ applied: true }>(`/api/projects/${encodeURIComponent(v.projectId)}/capabilities/${encodeURIComponent(v.capability)}`, { enabled: v.enabled }),
      onSuccess: () => refresh('capabilities'),
    }),
  };
}
