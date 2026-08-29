import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { ME_KEY } from '../lib/query-client';

/** `GET /auth/me`: the signed-in account and the member it is linked to, or null. A 401 is the signed-out state. */
export interface Me {
  sub: string;
  login: string;
  member: { id: string; label: string | null } | null;
}

export function useMe() {
  return useQuery({ queryKey: [...ME_KEY], queryFn: ({ signal }) => fetchJson<Me>('/auth/me', signal) });
}
