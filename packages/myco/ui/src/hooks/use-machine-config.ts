import { useMutation, useQueryClient } from '@tanstack/react-query';
import { usePowerQuery } from './use-power-query';
import { fetchJson, putJson } from '../lib/api';

/**
 * Machine config — `~/.myco/config.yaml`. One daemon per machine; this is
 * the durable home for the daemon port, log policy, and update channel.
 *
 * Mirrors the server-side `MachineConfigSchema` in
 * `packages/myco/src/config/schema.ts`. Optional fields here match the
 * Zod schema; required fields all have defaults so the GET response is
 * always populated.
 */
export interface MachineConfig {
  daemon: {
    port: number | null;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    log_retention_days: number;
    update_channel: 'stable' | 'beta';
  };
  /** Optional override of the auto-resolved machine id. */
  machine_id?: string;
  /**
   * Grove registry passthrough — read-only on this surface; the registry
   * (myco_groves) owns this block.
   */
  grove?: {
    default_grove_id?: string;
    [key: string]: unknown;
  };
}

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
      queryClient.invalidateQueries({ queryKey: ['merged-config'] });
    },
  });
}
