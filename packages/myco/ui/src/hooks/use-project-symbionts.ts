import { useMutation, useQueryClient } from '@tanstack/react-query';
import { deleteJson, fetchJson, patchJson, postJson, putJson } from '../lib/api';
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

/**
 * Toggle per-project symbiont customization as a whole. Body shape is
 * `{ enabled: boolean }`.
 *
 *   `enabled: true`  — ensure the project's `symbionts:` block exists,
 *                      pre-populated with every detected symbiont so
 *                      per-symbiont toggles in the UI become meaningful.
 *   `enabled: false` — REMOVE the block entirely; the project follows
 *                      global defaults again.
 *
 * Uses the canonical TanStack `mutate(variables, options)` shape.
 */
export function useSetProjectSymbiontCustomization() {
  const qc = useQueryClient();
  const selection = useActiveProjectSelection();
  return useMutation({
    mutationFn: async (body: { enabled: boolean }) => {
      if (!selection) throw new Error('No project selected');
      return putJson<{ projectCustomizationActive: boolean; symbionts: Record<string, { enabled: boolean }> }>(
        `/projects/${selection.project.project_id}/symbionts-customization`,
        body,
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['symbionts'] });
    },
  });
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

// NOTE: convenience wrappers `useSetSymbiontOverride` and
// `useResetSymbiontOverride` were removed — they spread the
// underlying TanStack mutation result and overrode `.mutate` with a
// non-standard positional signature, which would silently misbind
// any caller using TanStack's canonical `mutate(variables, options)`
// shape. Call sites now use `usePatchProjectSymbionts()` directly
// with an explicit `{ symbionts: { [name]: { enabled } | null } }`
// patch payload — preserves the option-routing contract.

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
