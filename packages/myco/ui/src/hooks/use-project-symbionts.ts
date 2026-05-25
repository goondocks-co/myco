import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteJson, fetchJson, patchJson, postJson } from '../lib/api';
import { useActiveProjectSelection } from './use-project-selection';

/**
 * Hooks for the per-project Symbiont page surface — toggling enabled
 * state, committing Myco config to the repo, draining the brownfield
 * migration queue. Each mutation invalidates the queries the page
 * reads so the UI converges on the new server state automatically.
 */

interface PatchSymbiontsBody {
  symbionts: Record<string, { enabled: boolean } | null>;
}

interface CommitToRepoBody {
  write_launchers?: boolean;
  runtime_command?: string;
}

interface UncommitFromRepoBody {
  remove_launchers?: boolean;
  remove_runtime_command?: boolean;
}

interface CommitToRepoResponse {
  ok: true;
  project_id: string;
  grove_id: string;
  manifest_path: string;
  wrote: string[];
}

interface UncommitFromRepoResponse {
  ok: true;
  project_id: string;
  manifest_path: string;
  removed: string[];
}

interface DrainMigrationResponse {
  migration: {
    passId: string;
    passedAt: number;
    projectsVisited: number;
    projectsCleaned: number;
    projectsErrored: number;
    outcomes: unknown[];
  };
}

export function usePatchProjectSymbionts() {
  const qc = useQueryClient();
  const selection = useActiveProjectSelection();
  return useMutation({
    mutationFn: async (patch: PatchSymbiontsBody) => {
      if (!selection) throw new Error('No project selected');
      return patchJson<{ symbionts: Record<string, { enabled: boolean }> }>(
        `/projects/${selection.project.project_id}/symbionts`,
        patch,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['symbionts'] });
    },
  });
}

export function useCommitToRepo() {
  const qc = useQueryClient();
  const selection = useActiveProjectSelection();
  return useMutation({
    mutationFn: async (body: CommitToRepoBody = {}) => {
      if (!selection) throw new Error('No project selected');
      return postJson<CommitToRepoResponse>(
        `/projects/${selection.project.project_id}/commit-to-repo`,
        body,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useUncommitFromRepo() {
  const qc = useQueryClient();
  const selection = useActiveProjectSelection();
  return useMutation({
    mutationFn: async (body: UncommitFromRepoBody = {}) => {
      if (!selection) throw new Error('No project selected');
      return deleteJson<UncommitFromRepoResponse>(
        `/projects/${selection.project.project_id}/commit-to-repo`,
        body,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}

export function useDrainMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => fetchJson<DrainMigrationResponse>(
      '/symbionts/drain-migration',
      { method: 'POST' },
    ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['symbionts'] });
      void qc.invalidateQueries({ queryKey: ['groves'] });
    },
  });
}
