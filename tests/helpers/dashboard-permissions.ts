import { dashboardPermissions } from '@myco-server-worker/auth/dashboard-permissions.js';

type DashboardFixturePermissions = ReturnType<typeof dashboardPermissions>;

/** A server /auth/me fixture with permissions from the serving policy. */
export function dashboardMe<T>(value: T): T & { permissions: DashboardFixturePermissions; membership: { state: 'active' | 'inactive' | 'unlinked'; reason: string | null } } {
  const me = value as { owner?: boolean; member?: { role?: 'admin' | 'member' } | null; permissions?: Partial<DashboardFixturePermissions>; membership?: { state: 'active' | 'inactive' | 'unlinked'; reason: string | null } };
  const linked = me.member != null;
  return {
    ...value,
    membership: me.membership ?? { state: linked ? 'active' : 'unlinked', reason: null },
    permissions: {
      ...dashboardPermissions({
        kind: linked ? 'member' : 'account', deploymentId: 'fixture', transport: 'http', live: linked,
        memberId: linked ? 'fixture-member' : undefined,
        role: me.owner === true ? 'owner' : me.member?.role,
      }),
      ...me.permissions,
    },
  };
}
