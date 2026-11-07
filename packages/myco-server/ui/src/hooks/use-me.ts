import { useMutation, useQuery, useQueryClient, type UseMutationOptions } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { ME_KEY } from '../lib/query-client';
import { live } from '../lib/live';

/** `GET /auth/me`: the signed-in account and the member it is linked to, or null. A 401 is the signed-out state. */
export interface Me {
  sub: string;
  login: string;
  owner: boolean;
  member: { id: string; label: string | null; role: 'admin' | 'member' } | null;
  membership: { state: 'active' | 'inactive' | 'unlinked' | 'unclaimed'; reason: string | null };
  permissions: DashboardPermissions;
}

export interface DashboardPermissions {
  runners: Permission;
  settings: Permission;
  keys: Permission;
  people: Permission;
  roles: Permission;
  projects: Permission;
  backups: Permission;
  machines: ScopedPermission<'all' | 'own' | 'none'>;
  machineSettings: ScopedPermission<'all' | 'own' | 'none'>;
  runsCancel: ScopedPermission<'all' | 'own' | 'none'>;
  raw: ScopedPermission<'own' | 'none'>;
}

interface Permission { allowed: boolean; reason: string | null }
interface ScopedPermission<Scope extends string> { scope: Scope; reason: string | null }

/** The Deployment's permission projection decides whether an action is offered. */
export function permissionOf(me: Me | undefined, key: 'runners' | 'settings' | 'keys' | 'people' | 'roles' | 'projects' | 'backups'): Permission {
  const projected = me?.permissions?.[key];
  if (projected !== undefined) return projected;
  return { allowed: false, reason: 'This permission is unavailable. Refresh the page.' };
}

/** Scope is the server's role permission, then the named resource's owner is checked at the control. */
export function scopeOf(me: Me | undefined, key: 'machines' | 'machineSettings' | 'runsCancel'): ScopedPermission<'all' | 'own' | 'none'> {
  const projected = me?.permissions?.[key];
  if (projected !== undefined) return projected;
  return { scope: 'none', reason: 'This permission is unavailable. Refresh the page.' };
}

/** `enabled: false` leaves the session unasked, for a page that shows the same thing to everyone. */
export function useMe(options: { enabled?: boolean } = {}) {
  return useQuery({ queryKey: [...ME_KEY], queryFn: ({ signal }) => fetchJson<Me>('/auth/me', signal), enabled: options.enabled ?? true, ...live('still') });
}

/** Whether the Deployment permits ordinary administration for this viewer. */
export function useIsAdmin(): boolean {
  return permissionOf(useMe().data, 'settings').allowed;
}

/** Identity-changing writes retain their outcome while the shared identity owns refresh failure. */
export function useIdentityMutation<TData, TVariables>(options: Omit<UseMutationOptions<TData, Error, TVariables>, 'mutationFn'> & { mutationFn: (variables: TVariables) => Promise<TData> }) {
  const client = useQueryClient();
  return useMutation({
    ...options,
    mutationFn: async (variables: TVariables) => {
      const result = await options.mutationFn(variables);
      await client.cancelQueries({ queryKey: ME_KEY, exact: true });
      try {
        await client.fetchQuery({ queryKey: ME_KEY, queryFn: ({ signal }) => fetchJson<Me>('/auth/me', signal), staleTime: 0 });
      } catch {
        await client.invalidateQueries({ queryKey: ME_KEY, exact: true, refetchType: 'none' });
      }
      return result;
    },
  });
}
