import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../lib/api';
import type { ConnectAnswer, ConnectRequest, DismissAnswer, DismissRequest, UncapturedAnswer, UncapturedRootItem } from '../features/today/wire';
import { live } from '../lib/live';

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
    ...live<UncapturedAnswer>({ follows: ['sessions'] }),
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

/** Stop asking about one of them, and with a folder, about every repository under it on that machine; the list is read again after. */
export function useDismissUncaptured() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ item, folder }: { item: Pick<UncapturedRootItem, 'machineId' | 'rootKey'>; folder?: string }) =>
      postJson<DismissAnswer>(`/api/uncaptured/${encodeURIComponent(item.machineId)}/${encodeURIComponent(item.rootKey)}/dismiss`, (folder === undefined ? {} : { folder }) satisfies DismissRequest),
    onSuccess: () => client.invalidateQueries({ queryKey: ['uncaptured'] }),
  });
}
