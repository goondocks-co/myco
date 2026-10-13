import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SetupProgress } from '../features/today/wire';
import { fetchJson } from '../lib/api';
import { readHidden, rememberHidden, setupComplete } from '../lib/setup-progress';
import { permissionOf, useMe } from './use-me';
import { LIVE_REFRESH_MS } from './use-work';

export function useSetupProgress() {
  const me = useMe();
  const member = me.data?.member;
  const admin = permissionOf(me.data, 'settings').allowed;
  const [hidden, setHidden] = useState(readHidden);
  const progress = useQuery({
    queryKey: ['setup-progress', member?.id, member?.role],
    queryFn: ({ signal }) => fetchJson<SetupProgress>('/api/setup', signal),
    enabled: member != null && !hidden,
    refetchInterval: (query) => query.state.status === 'success' && setupComplete(query.state.data, admin) ? false : LIVE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
  return {
    ...progress, admin, hidden, complete: !progress.error && setupComplete(progress.data, admin),
    dismiss: () => { rememberHidden(true); setHidden(true); },
    show: () => { rememberHidden(false); setHidden(false); },
  };
}
