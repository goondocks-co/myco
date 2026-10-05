import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { ME_KEY } from '../lib/query-client';

/** `GET /auth/me`: the signed-in account and the member it is linked to, or null. A 401 is the signed-out state. */
export interface Me {
  sub: string;
  login: string;
  owner: boolean;
  member: { id: string; label: string | null; role: 'admin' | 'member' } | null;
}

/** `enabled: false` leaves the session unasked, for a page that shows the same thing to everyone. */
export function useMe(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: [...ME_KEY], queryFn: ({ signal }) => fetchJson<Me>('/auth/me', signal), enabled: options.enabled ?? true });
}

/** Whether the signed-in member administers the Deployment. The server refuses a member every admin route; this only keeps the controls that reach one out of their view. */
export function useIsAdmin(): boolean {
  return useMe().data?.member?.role === 'admin';
}
