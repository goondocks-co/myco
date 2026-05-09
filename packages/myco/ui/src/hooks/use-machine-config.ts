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
  machine_id?: string;
};

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
  return useMutation<MachineConfig, Error, MachineConfigPatch>({
    mutationFn: (patch) => putJson<MachineConfig>('/machine-config', { patch }),
    onSuccess: (config) => {
      queryClient.setQueryData<MachineConfigResponse>(
        [...MACHINE_CONFIG_QUERY_KEY],
        { config },
      );
      queryClient.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}
