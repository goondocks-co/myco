import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson } from '../lib/api';
import { useActiveProjectSelection } from './use-project-selection';
import { requestContextHeadersForSelection } from '../lib/selection';

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
  const selection = useActiveProjectSelection();
  const groveId = selection?.grove.id ?? null;
  const headers = requestContextHeadersForSelection(selection);
  return useQuery({
    queryKey: groveConfigQueryKey(groveId),
    queryFn: ({ signal }) => fetchJson<GroveConfigResponse>('/grove-config', { signal, headers }),
    enabled: groveId !== null,
  });
}

export interface GroveConfigWrite {
  patch?: Partial<GroveConfig>;
  /** Dot-paths removed from the Grove file (server clears before patching). */
  clear?: string[];
}

export function useUpdateGroveConfig() {
  const qc = useQueryClient();
  const selection = useActiveProjectSelection();
  const groveId = selection?.grove.id ?? null;
  const headers = requestContextHeadersForSelection(selection);

  return useMutation({
    mutationFn: ({ patch, clear }: GroveConfigWrite) =>
      putJson<GroveConfig>('/grove-config', { patch, clear }, { headers }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: groveConfigQueryKey(groveId) });
      // The merged-config view depends on Grove tier values, so bust it.
      void qc.invalidateQueries({ queryKey: ['config', 'merged'] });
    },
  });
}
