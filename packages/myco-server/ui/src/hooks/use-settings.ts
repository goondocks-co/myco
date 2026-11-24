import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, deleteJson, fetchJson, patchJson, postJson, putJson } from '../lib/api';
import type { EmbeddingSwitchEstimate, EmbeddingSwitchStatus, HealthPassedOverList } from '@goondocks/myco-shared/settings-contract';
import type { ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import type { GitHubAppSetup, RepositorySuggestion, RepositorySuggestions } from '@goondocks/myco-shared/github-app-setup';

import type { SecretRow, SettingsAnswer, SecretsAnswer, TitlingBackfillProgress } from '../features/admin/settings/wire';
import type { ApprovedAccountRow, CapabilitiesAnswer, InstallationsAnswer, RepositoryAnswer, RepositoryChoicesAnswer } from '../features/admin/project/wire';
import { live } from '../lib/live';
export type { LeafRow, SecretRow } from '../features/admin/settings/wire';
export type { RepositoryRow } from '../features/admin/project/wire';

/** Whether Settings is in motion: an embedding model switch stands or a changed idle close is moving sessions, so it is read again until that settles. */
export const settingsMoving = (answer: SettingsAnswer | undefined): boolean =>
  answer?.embedding?.switch != null || answer?.leaves.some(row => row.learningDeadlines?.rebuilding === true) === true;

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: ({ signal }) => fetchJson<SettingsAnswer>('/api/settings', signal),
    ...live<SettingsAnswer>({ whileMoving: settingsMoving }),
  });
}

/** A switch operation's answer: the switch as it now stands. */
interface SwitchAnswer { applied: true; switch: EmbeddingSwitchStatus | null }

const SWITCH_KEY = ['embedding-switch'] as const;

/** The switch of the embedding model under way, or null: `GET /api/embedding/switch`, read again while one stands. */
export function useEmbeddingSwitch() {
  return useQuery({
    queryKey: [...SWITCH_KEY],
    queryFn: ({ signal }) => fetchJson<{ switch: EmbeddingSwitchStatus | null }>('/api/embedding/switch', signal).then((answer) => answer.switch),
    ...live<EmbeddingSwitchStatus | null>({ whileMoving: (data) => data != null }),
  });
}

/** The sources search by meaning passes over, each named with why: `GET /api/embedding/passed-over`. */
export function usePassedOver() {
  return useQuery({ queryKey: ['embedding-passed-over'], queryFn: ({ signal }) => fetchJson<HealthPassedOverList>('/api/embedding/passed-over', signal), ...live('still') });
}

export function useSecrets() {
  return useQuery({ queryKey: ['secrets'], queryFn: ({ signal }) => fetchJson<SecretsAnswer>('/api/secrets', signal), ...live('still') });
}

export function useCapabilities(projectId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: ['capabilities', projectId],
    queryFn: ({ signal }) => fetchJson<CapabilitiesAnswer>(`/api/projects/${encodeURIComponent(projectId)}/capabilities`, signal),
    ...live('still'),
  });
}

export const isSettingsConflict = (error: unknown): error is ApiError => error instanceof ApiError && error.status === 409;

/** What the server said when it refused a settings change, in the person's words. */
export function settingsRefusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; reason?: unknown; detail?: unknown } | null;
    if (body?.error === 'conflict') return 'This changed since the page read it. Refresh before saving again.';
    if (body?.error === 'github_access' && typeof body.reason === 'string') return body.reason;
    if (body?.error === 'bad_request') return 'The server could not accept that.';
    switch (body?.reason) {
      case 'not_deployment_tier':
        return 'That setting is not held by the server.';
      case 'malformed':
        return 'The server could not read that value.';
      case 'retired':
        return 'That setting is retired.';
      case 'conflict':
        return 'This changed since the page read it. Review the current value before saving again.';
      case 'revision_required':
        return 'Reload this setting before saving it.';
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
  const revisionFor = (leaf: string, revision?: number) => {
    const current = revision ?? client.getQueryData<SettingsAnswer>(['settings'])?.leaves.find(row => row.leaf === leaf)?.revision;
    if (current === undefined) throw new Error('Read the setting before changing it');
    return { 'if-match': String(current) };
  };
  const onConflict = async (error: unknown) => {
    if (isSettingsConflict(error)) await refresh('settings', 'capabilities', 'titling-backfill', 'tasks');
  };
  return {
    setLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string; value: unknown; revision?: number }) => putJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, { value: v.value }, revisionFor(v.leaf, v.revision)),
      // Where titling stands reads the scheduling switch and the task overrides, so it is read again with the settings.
      onError: onConflict,
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    resetLeaf: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string; revision?: number }) => deleteJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, revisionFor(v.leaf, v.revision)),
      onError: onConflict,
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    /** Removes the quick-jobs address and its model in one write, against both revisions the page read. */
    clearQuickJobsAddress: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaves: readonly string[] }) => deleteJson<{ applied: true }>('/api/quick-jobs/address',
        { 'if-match': JSON.stringify(Object.fromEntries(v.leaves.map((leaf) => [leaf, Number(revisionFor(leaf)['if-match'])]))) }),
      onError: onConflict,
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    repairDocument: useMutation({
      gcTime: 0,
      mutationFn: (v: { leaf: string }) => postJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}/repair`, {}, revisionFor(v.leaf)),
      onError: onConflict,
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    setEmbedding: useMutation({
      gcTime: 0,
      mutationFn: ({ revisions, ...choice }: { provider: string; model?: string; endpoint?: string; revisions?: Record<string, number> }) => putJson<{ applied: true }>('/api/embedding', choice, { 'if-match': JSON.stringify(revisions ?? Object.fromEntries(['embedding.provider', 'embedding.model', 'embedding.base_url'].map(leaf => [leaf, Number(revisionFor(leaf)['if-match'])]))) }),
      onError: onConflict,
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
      onError: onConflict,
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    cancelSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { id: string }) => deleteJson<SwitchAnswer>(`/api/embedding/switch/${encodeURIComponent(v.id)}`),
      onError: onConflict,
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    resumeSwitch: useMutation({
      gcTime: 0,
      mutationFn: (v: { id: string }) => postJson<SwitchAnswer>(`/api/embedding/switch/${encodeURIComponent(v.id)}/resume`),
      onError: onConflict,
      onSuccess: () => refresh('settings', SWITCH_KEY[0]),
    }),
    setTaskTier: useMutation({
      gcTime: 0,
      mutationFn: (v: { task: string; tier: ReasoningTier | null }) => patchJson<{ applied: true }>('/api/settings/agent.tasks', v, revisionFor('agent.tasks')),
      onError: onConflict,
      onSuccess: () => refresh('settings', 'titling-backfill', 'tasks'),
    }),
    setSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string; value: string }) => putJson<SecretRow>(`/api/secrets/${encodeURIComponent(v.name)}`, { value: v.value }),
      onError: onConflict,
      // Whether each agent has a usable stored key is read with the runners.
      onSuccess: () => refresh('secrets', 'runners'),
    }),
    deleteSecret: useMutation({
      gcTime: 0,
      mutationFn: (v: { name: string }) => deleteJson<{ deleted: boolean }>(`/api/secrets/${encodeURIComponent(v.name)}`),
      onError: onConflict,
      onSuccess: () => refresh('secrets', 'runners'),
    }),
    setProjectSetting: useMutation({
      mutationFn: (v: { projectId: string; leaf: string; value: number; revision: number }) =>
        putJson<{ applied: true }>(`/api/settings/${encodeURIComponent(v.leaf)}`, { project_id: v.projectId, value: v.value }, { 'if-match': String(v.revision) }),
      onError: onConflict,
      onSuccess: () => refresh('capabilities', 'tasks'),
    }),
    setCapability: useMutation({
      mutationFn: (v: { projectId: string; capability: string; enabled: boolean; revision: number }) =>
        putJson<{ applied: true }>(`/api/projects/${encodeURIComponent(v.projectId)}/capabilities/${encodeURIComponent(v.capability)}`, { enabled: v.enabled }, { 'if-match': String(v.revision) }),
      onError: onConflict,
      onSuccess: () => refresh('capabilities', 'tasks', 'attention', 'setup-progress'),
    }),
  };
}

export function useRepository(projectId: string) {
  return useQuery({
    queryKey: ['repository', projectId],
    queryFn: ({ signal }) => fetchJson<RepositoryAnswer>(`/api/projects/${encodeURIComponent(projectId)}/repository`, signal),
    ...live('still'),
  });
}

const repositoryPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/repository`;
/** Everything that reads a Project's repository connection, read again once it changes. */
const refreshRepository = (client: ReturnType<typeof useQueryClient>, projectId: string) => Promise.all([
  client.invalidateQueries({ queryKey: ['repository', projectId] }),
  ...['attention', 'setup-progress', 'task-start'].map(key => client.invalidateQueries({ queryKey: [key] })),
]);

export function useRepositoryActions(projectId: string) {
  const client = useQueryClient();
  const path = repositoryPath(projectId);
  const refresh = () => refreshRepository(client, projectId);
  return {
    save: useMutation({
      gcTime: 0,
      mutationFn: (input: { installationId: number; repositoryId: number; branch: string; revision: string | null }) =>
        putJson<RepositoryAnswer>(path, input),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (revision: string) => deleteJson(path, {}, { revision }),
      onSuccess: refresh,
    }),
  };
}

const GITHUB_APP_KEY = 'github-app';
const INSTALLATIONS_KEY = [GITHUB_APP_KEY, 'installations'] as const;

/** The live facts behind the GitHub App setup checklist, asked of GitHub when the section opens and when an admin checks again. */
export function useGitHubAppSetup() {
  return useQuery({ queryKey: [GITHUB_APP_KEY, 'setup'], retry: false, queryFn: ({ signal }) => fetchJson<GitHubAppSetup>('/api/github-app', signal), ...live('heavy'), refetchOnMount: 'always' });
}

/** A repository proposed for each Project with none, asked of GitHub only when an admin asks. */
export function useRepositorySuggestions() {
  return useQuery({ queryKey: [GITHUB_APP_KEY, 'suggestions'], enabled: false, retry: false,
    queryFn: ({ signal }) => fetchJson<RepositorySuggestions>('/api/github-app/suggestions', signal), ...live('heavy') });
}

/** Connects a proposed repository to its Project with its default branch, through the Project's own repository connection. */
export function useConnectSuggestion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (proposal: RepositorySuggestion) => putJson<RepositoryAnswer>(repositoryPath(proposal.projectId),
      { installationId: proposal.installationId, repositoryId: proposal.repositoryId, branch: proposal.defaultBranch, revision: null }),
    onSuccess: (_answer, proposal) => Promise.all([refreshRepository(client, proposal.projectId), client.invalidateQueries({ queryKey: [GITHUB_APP_KEY, 'setup'] })]),
  });
}

/** The App's installations and the accounts approved here, asked of GitHub only when an admin opens or refreshes them. */
export function useGitHubInstallations(enabled: boolean, page = 1) {
  return useQuery({
    queryKey: [...INSTALLATIONS_KEY, 'page', page], enabled, retry: false,
    queryFn: ({ signal }) => fetchJson<InstallationsAnswer>(`/api/github-app/installations?page=${page}`, signal),
    ...live('still'),
  });
}

/** One page of an approved installation's repositories, asked of GitHub when an admin picks the installation. */
export function useInstallationRepositories(installationId: number | null, page: number) {
  return useQuery({
    queryKey: [...INSTALLATIONS_KEY, installationId, page], enabled: installationId !== null, retry: false,
    queryFn: ({ signal }) => fetchJson<RepositoryChoicesAnswer>(`/api/github-app/installations/${installationId}/repositories?page=${page}`, signal),
    ...live('still'),
  });
}

/** Approve the account holding an installation, or withdraw an account's approval; the setup checklist is read again too. */
export function useGitHubAccountActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: [GITHUB_APP_KEY] });
  return {
    approve: useMutation({
      mutationFn: (installationId: number) => postJson<{ account: ApprovedAccountRow }>('/api/github-app/accounts', { installationId }),
      onSuccess: refresh,
    }),
    withdraw: useMutation({
      mutationFn: (accountId: number) => deleteJson(`/api/github-app/accounts/${accountId}`, {}, {}),
      onSuccess: refresh,
    }),
  };
}

const TITLING_KEY = ['titling-backfill'] as const;

/** Where titling imported sessions stands, and its switch: `GET /api/titling-backfill`. */
export function useTitlingBackfill() {
  return useQuery({ queryKey: [...TITLING_KEY], queryFn: ({ signal }) => fetchJson<TitlingBackfillProgress>('/api/titling-backfill', signal), ...live({ follows: ['runs'] }) });
}

/**
 * Turns titling imported sessions on or off: `PUT /api/titling-backfill`. The
 * answer is where titling then stands, so it replaces the read; the switch is
 * written into the task overrides, so the leaves are read again too.
 */
export function useSetTitlingBackfill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => {
      const revision = client.getQueryData<SettingsAnswer>(['settings'])?.leaves.find(row => row.leaf === 'agent.tasks')?.revision;
      if (revision === undefined) throw new Error('Read settings before changing titling');
      return putJson<TitlingBackfillProgress>('/api/titling-backfill', { enabled }, { 'if-match': String(revision) });
    },
    onError: async () => { await Promise.all(['settings', 'titling-backfill'].map(key => client.invalidateQueries({ queryKey: [key] }))); },
    onSuccess: (data) => { client.setQueryData([...TITLING_KEY], data); void client.invalidateQueries({ queryKey: ['settings'] }); },
  });
}
