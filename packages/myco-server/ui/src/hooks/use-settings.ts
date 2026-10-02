import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, deleteJson, fetchJson, patchJson, postJson, putJson } from '../lib/api';
import type { EmbeddingSwitchEstimate, EmbeddingSwitchStatus } from '@goondocks/myco-shared/settings-contract';
import type { ReasoningTier } from '@goondocks/myco-shared/execution-profile';

import type { SecretRow, SettingsAnswer, SecretsAnswer, TitlingBackfillProgress } from '../features/admin/settings/wire';
import type { CapabilitiesAnswer, RepositoryAnswer } from '../features/admin/project/wire';
export type { LeafRow, SecretRow } from '../features/admin/settings/wire';
export type { RepositoryRow } from '../features/admin/project/wire';

/** How often Settings reads itself again: while an embedding model switch stands, as Health does, and otherwise never on its own. */
export const settingsRefreshInterval = (answer: SettingsAnswer | undefined): number | false =>
  answer?.embedding?.switch != null ? SWITCH_REFRESH_MS : false;

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => fetchJson<SettingsAnswer>('/api/settings', signal),
    refetchInterval: (query) => settingsRefreshInterval(query.state.data),
  });
}

/** A switch operation's answer: the switch as it now stands. */
interface SwitchAnswer { applied: true; switch: EmbeddingSwitchStatus | null }

const SWITCH_KEY = ['embedding-switch'] as const;
/** How often a page showing a switch under way reads it again. */
const SWITCH_REFRESH_MS = 10_000;

/** The switch of the embedding model under way, or null: `GET /api/embedding/switch`, read again while one stands. */
export function useEmbeddingSwitch() {
  return useQuery({
    queryKey: [...SWITCH_KEY],
    queryFn: ({ signal }) => fetchJson<{ switch: EmbeddingSwitchStatus | null }>('/api/embedding/switch', signal).then((answer) => answer.switch),
    refetchInterval: (query) => query.state.data != null ? SWITCH_REFRESH_MS : false,
  });
}

export function useSecrets() {
  return useQuery({ queryKey: ['secrets'], queryFn: ({ signal }) => fetchJson<SecretsAnswer>('/api/secrets', signal) });
}

export function useCapabilities(projectId: string) {
  return useQuery({
    queryKey: ['capabilities', projectId],
    queryFn: ({ signal }) => fetchJson<CapabilitiesAnswer>(`/api/projects/${encodeURIComponent(projectId)}/capabilities`, signal),
  });
}

/** What the server said when it refused a settings change, in the person's words. */
export function settingsRefusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; reason?: unknown; detail?: unknown } | null;
    if (body?.error === 'conflict') return 'This changed since the page read it. Refresh before saving again.';
    if (body?.error === 'bad_request') return 'The server could not accept that.';
    switch (body?.reason) {
      case 'not_deployment_tier':
        return 'That setting is not held by the server.';
      case 'malformed':
        return 'The server could not read that value.';
      case 'retired':
        return 'That setting is retired.';
      case 'conflict':
        return 'This changed since the page read it. Refresh before saving again.';
      case 'invalid_value':
        return typeof body.detail === 'string' && body.detail !== '' ? `The server refused that value: ${body.detail.replace(/\.$/, '')}.` : 'The server refused that value.';
      case 'unknown_capability':
        return 'The server does not offer that here.';
      default:
        return `The server refused (${err.status}).`;
    }
  }
  return 'Could not reach the server.';
}

/** What the server said when it refused to start, resume or cancel a switch of the embedding model, in the person's words. */
export function switchRefusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const detail = (err.body as { detail?: unknown } | null)?.detail;
    if (typeof detail === 'string' && detail !== '') return `${detail.replace(/\.$/, '')}.`;
  }
  return settingsRefusalText(err);
}

/** One mutation per settings act. A mutation that carries a secret keeps no copy once it has answered. */
export function useSettingsActions() {
  const client = useQueryClient();
  const refresh = (...keys: string[]) => Promise.all(keys.map((k) => client.invalidateQueries({ queryKey: [k] })));
  return {
    setLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string; value: unknown }) => putJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, { value: v.value }),
      // Where titling stands reads the scheduling switch and the task overrides, so it is read again with the settings.
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    resetLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string }) => deleteJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`),
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    setEmbedding: useMutation({
      gcTime: 0,
      mutationFn: (v: { provider: string; model?: string; endpoint?: string }) => putJson<{ applied: true }>('/api/embedding', v),
      onSuccess: () => refresh('settings'),
    }),
    estimateSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { provider: string; model: string; endpoint?: string }) =>
        postJson<{ applied: true; estimate: EmbeddingSwitchEstimate }>('/api/embedding/switch/estimate', v).then((answer) => answer.estimate),
    }),
    startSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { provider: string; model: string; endpoint?: string }) => postJson<SwitchAnswer>('/api/embedding/switch', { ...v, confirm: true }),
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    cancelSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { id: string }) => deleteJson<SwitchAnswer>(`/api/embedding/switch/${encodeURIComponent(v.id)}`),
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    resumeSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { id: string }) => postJson<SwitchAnswer>(`/api/embedding/switch/${encodeURIComponent(v.id)}/resume`),
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    setTaskTier: useMutation({
      gcTime: 0,
      mutationFn: (v: { task: string; tier: ReasoningTier | null }) => patchJson<{ applied: true }>('/api/settings/agent.tasks', v),
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
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

export function useRepository(projectId: string) {
  return useQuery({
    queryKey: ['repository', projectId],
    queryFn: ({ signal }) => fetchJson<RepositoryAnswer>(`/api/projects/${encodeURIComponent(projectId)}/repository`, signal),
  });
}

export function useRepositoryActions(projectId: string) {
  const client = useQueryClient();
  const path = `/api/projects/${encodeURIComponent(projectId)}/repository`;
  const refresh = () => client.invalidateQueries({ queryKey: ['repository', projectId] });
  return {
    save: useMutation({
      gcTime: 0,
      mutationFn: (input: { url: string; branch: string; revision: string | null; credential?: { username: string; token: string } | null }) =>
        putJson<RepositoryAnswer>(path, input),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (revision: string) => deleteJson(path, {}, { revision }),
      onSuccess: refresh,
    }),
  };
}

const TITLING_KEY = ['titling-backfill'] as const;

/** Where titling imported sessions stands, and its switch: `GET /api/titling-backfill`. */
export function useTitlingBackfill() {
  return useQuery({ queryKey: [...TITLING_KEY], queryFn: ({ signal }) => fetchJson<TitlingBackfillProgress>('/api/titling-backfill', signal) });
}

/**
 * Turns titling imported sessions on or off: `PUT /api/titling-backfill`. The
 * answer is where titling then stands, so it replaces the read; the switch is
 * written into the task overrides, so the leaves are read again too.
 */
export function useSetTitlingBackfill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => putJson<TitlingBackfillProgress>('/api/titling-backfill', { enabled }),
    onSuccess: (data) => { client.setQueryData([...TITLING_KEY], data); void client.invalidateQueries({ queryKey: ['settings'] }); },
  });
}
