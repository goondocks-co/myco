import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, putJson } from '../lib/api';

// Single source of truth for the Machine-tier shape lives next to the
// Zod schema. Type-only import keeps zod runtime out of the UI bundle.
export type { MachineConfig } from '@myco/config/schema';
import type { MachineConfig } from '@myco/config/schema';

export interface MachineConfigResponse {
  config: MachineConfig;
}

export type MachineConfigPatch = {
  daemon?: Partial<MachineConfig['daemon']>;
  capture?: Partial<MachineConfig['capture']>;
  notifications?: Partial<MachineConfig['notifications']>;
  machine_id?: string;
};

export interface MachineConfigWrite {
  patch?: MachineConfigPatch;
  /** Dot-paths removed from the machine file (server clears before patching). */
  clear?: string[];
}

const MACHINE_CONFIG_QUERY_KEY = ['machine-config'] as const;

/** GET /api/machine-config — returns the current machine config (always present). */
export function useMachineConfig() {
  return usePowerQuery<MachineConfigResponse>({
    queryKey: [...MACHINE_CONFIG_QUERY_KEY],
    queryFn: ({ signal }) => fetchJson<MachineConfigResponse>('/machine-config', { signal }),
    refetchInterval: false,
    pollCategory: 'standard',
    contextFree: true,
  });
}

/**
 * PUT /api/machine-config — patch machine config. Server deep-merges the
 * patch into the existing config, validates with `MachineConfigSchema`,
 * and writes through `saveMachineConfig`. Returns the full validated
 * `MachineConfig`.
 *
 * On success we invalidate both the read query and the merged-config
 * query so anything depending on the merged tier picks up the new
 * values without a manual reload.
 */
export function useUpdateMachineConfig() {
  const queryClient = useQueryClient();
  return useMutation<MachineConfig, Error, MachineConfigWrite>({
    mutationFn: ({ patch, clear }) => putJson<MachineConfig>('/machine-config', { patch, clear }),
    onSuccess: (config) => {
      queryClient.setQueryData<MachineConfigResponse>(
        [...MACHINE_CONFIG_QUERY_KEY],
        { config },
      );
      queryClient.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Race-free list-mutation helpers for machine-tier array fields
// ---------------------------------------------------------------------------

/**
 * Add a value to a machine-config list path (e.g. `capture.ignore.paths`).
 * The server does the read-modify-write so concurrent callers don't overwrite
 * each other — no stale client-array read required.
 */
export function useAddToMachineConfigList() {
  const queryClient = useQueryClient();
  return useMutation<MachineConfig, Error, { path: string; value: string }>({
    mutationFn: ({ path, value }) =>
      putJson<MachineConfig>('/machine-config', {
        addToList: [{ path, values: [value] }],
      }),
    onSuccess: (config) => {
      queryClient.setQueryData<MachineConfigResponse>(
        [...MACHINE_CONFIG_QUERY_KEY],
        { config },
      );
      queryClient.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}

/**
 * Remove a value from a machine-config list path (e.g. `capture.ignore.paths`).
 * Server-side read-modify-write — no stale client-array read required.
 */
export function useRemoveFromMachineConfigList() {
  const queryClient = useQueryClient();
  return useMutation<MachineConfig, Error, { path: string; value: string }>({
    mutationFn: ({ path, value }) =>
      putJson<MachineConfig>('/machine-config', {
        removeFromList: [{ path, values: [value] }],
      }),
    onSuccess: (config) => {
      queryClient.setQueryData<MachineConfigResponse>(
        [...MACHINE_CONFIG_QUERY_KEY],
        { config },
      );
      queryClient.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}
