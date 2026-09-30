import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { AttentionAnswer } from '../features/today/wire';
import { freshness } from './use-work';

export type { AttentionAnswer, AttentionItem, AttentionKind } from '../features/today/wire';

/**
 * Needs you: what an administrator should act on. The route is an admin's, so
 * the read waits, unasked, until `enabled` says the viewer is one.
 */
export function useAttention({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ['attention'],
    queryFn: ({ signal }) => fetchJson<AttentionAnswer>('/api/attention', signal),
    enabled,
    ...freshness(true),
  });
}
