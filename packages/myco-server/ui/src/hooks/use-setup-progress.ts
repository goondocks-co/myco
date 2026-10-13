import { useQuery } from '@tanstack/react-query';
import type { SetupProgress } from '../features/today/wire';
import { fetchJson } from '../lib/api';
import { useMe } from './use-me';
import { freshness } from './use-work';

export function useSetupProgress() {
  const member = useMe().data?.member;
  return useQuery({
    queryKey: ['setup-progress', member?.id, member?.role],
    queryFn: ({ signal }) => fetchJson<SetupProgress>('/api/setup', signal),
    enabled: member != null,
    ...freshness(true),
  });
}
