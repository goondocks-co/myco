import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson } from '../lib/api';
import { useProjectSelection } from './use-project-selection';

// Single source of truth for the Grove-tier shape lives next to the
// Zod schema. Type-only import keeps zod runtime out of the UI bundle.
export type { GroveConfig } from '@myco/config/schema';
import type { GroveConfig } from '@myco/config/schema';

export interface GroveConfigResponse {
  groveId: string;
  config: GroveConfig;
}

const GROVE_CONFIG_KEY = ['grove-config'] as const;

function groveConfigQueryKey(groveId: string | null) {
  return [...GROVE_CONFIG_KEY, groveId ?? 'none'] as const;
}

export function useGroveConfig() {
  const selection = useProjectSelection();
  const groveId = selection?.grove.id ?? null;
  return useQuery({
    queryKey: groveConfigQueryKey(groveId),
    queryFn: ({ signal }) => fetchJson<GroveConfigResponse>('/grove-config', { signal }),
    enabled: groveId !== null,
  });
}

export function useUpdateGroveConfig() {
  const qc = useQueryClient();
  const selection = useProjectSelection();
  const groveId = selection?.grove.id ?? null;

  return useMutation({
    mutationFn: (patch: Partial<GroveConfig>) =>
      putJson<GroveConfig>('/grove-config', { patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groveConfigQueryKey(groveId) });
      // The merged-config view depends on Grove tier values, so bust it.
      void qc.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}
