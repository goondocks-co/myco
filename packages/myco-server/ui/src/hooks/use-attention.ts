import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { AttentionAnswer } from '../features/today/wire';
import { live } from '../lib/live';

export type { AttentionAnswer, AttentionItem, AttentionKind } from '../features/today/wire';

/**
 * Needs you: what an administrator should act on. The route is an admin's, so
 * the read waits, unasked, until `enabled` says the viewer is one.
 */
export function useAttention({ enabled, projectId }: { enabled: boolean; projectId?: string }) {
  return useQuery({
    queryKey: projectId === undefined ? ['attention'] : ['attention', projectId],
    queryFn: ({ signal }) => fetchJson<AttentionAnswer>(projectId === undefined ? '/api/attention' : `/api/attention?project=${encodeURIComponent(projectId)}`, signal),
    enabled,
    ...live<AttentionAnswer>({ follows: ['runs', 'sessions', 'fleet', 'attention'] }),
  });
}
