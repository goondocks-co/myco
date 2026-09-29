import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { ME_KEY } from '../lib/query-client';

/** `GET /auth/me`: the signed-in account and the member it is linked to, or null. A 401 is the signed-out state. */
export interface Me {
  sub: string;
  login: string;
  member: { id: string; label: string | null; role: 'admin' | 'member' } | null;
}

export function useMe() {
  return useQuery({ queryKey: [...ME_KEY], queryFn: ({ signal }) => fetchJson<Me>('/auth/me', signal) });
}

/** Whether the signed-in member administers the Deployment. The server refuses a member every admin route; this only keeps the controls that reach one out of their view. */
export function useIsAdmin(): boolean {
  return useMe().data?.member?.role === 'admin';
}
