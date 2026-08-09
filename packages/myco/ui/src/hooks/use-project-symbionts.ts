import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, patchJson, putJson } from '../lib/api';
import { useActiveProjectSelection } from './use-project-selection';

/**
 * Hooks for the per-project Symbiont page surface — toggling per-project
 * symbiont enablement (the one project-level override) and draining the
 * brownfield migration queue. Each mutation invalidates the queries the
 * page reads so the UI converges on the new server state automatically.
 */

interface PatchSymbiontsBody {
  symbionts: Record<string, { enabled: boolean } | null>;
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

// NOTE: there are deliberately no `useSetSymbiontOverride` /
// `useResetSymbiontOverride` convenience wrappers — spreading the
// underlying TanStack mutation result and overriding `.mutate` with a
// non-standard positional signature silently misbinds
// any caller using TanStack's canonical `mutate(variables, options)`
// shape. Call sites now use `usePatchProjectSymbionts()` directly
// with an explicit `{ symbionts: { [name]: { enabled } | null } }`
// patch payload — preserves the option-routing contract.

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
