import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { ConnectAnswer, ConnectRequest, UncapturedAnswer, UncapturedRootItem } from '../features/today/wire';
import { freshness } from './use-work';

export type { UncapturedAnswer, UncapturedRootItem } from '../features/today/wire';

/**
 * The repositories a member's machine is not capturing yet: an admin reads every machine's, any other member their own
 * machines' alone, so every viewer asks.
 */
export function useUncaptured({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['uncaptured'],
    queryFn: ({ signal }) => fetchJson<UncapturedAnswer>('/api/uncaptured', signal),
    enabled,
    ...freshness(true),
  });
}

const connectPath = (item: Pick<UncapturedRootItem, 'machineId' | 'rootKey'>): string =>
  `/api/uncaptured/${encodeURIComponent(item.machineId)}/${encodeURIComponent(item.rootKey)}/connect`;

/** Connect one of them, to a named project or to the one its remote names (or a new one); the list is read again after. */
export function useConnectUncaptured() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ item, projectId }: { item: Pick<UncapturedRootItem, 'machineId' | 'rootKey'>; projectId: string | null }) =>
      postJson<ConnectAnswer>(connectPath(item), (projectId === null ? {} : { projectId }) satisfies ConnectRequest),
    onSuccess: () => client.invalidateQueries({ queryKey: ['uncaptured'] }),
  });
}
