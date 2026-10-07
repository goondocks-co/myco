import { describe, expect, it } from 'bun:test';
import { errorWords } from '../../packages/myco-server/ui/src/design/patterns/ErrorState';
import { permissionOf, scopeOf, type Me } from '../../packages/myco-server/ui/src/hooks/use-me';
import { ApiError } from '../../packages/myco-server/ui/src/lib/api';
import { dashboardMe } from '../helpers/dashboard-permissions';

const admin: Me = dashboardMe({ sub: '1', login: 'ada', owner: false, member: { id: 'mem_ada', label: 'Ada', role: 'admin' } });

describe('dashboard RBAC projection', () => {
  it('uses the server permission and its reason even for an admin', () => {
    const me: Me = { ...admin, permissions: {
      settings: { allowed: false, reason: 'Settings are unavailable while ownership is pending.' },
      keys: { allowed: true, reason: null }, people: { allowed: true, reason: null },
      roles: { allowed: false, reason: 'Only the owner can change roles.' },
      projects: { allowed: true, reason: null }, backups: { allowed: true, reason: null },
      machines: { scope: 'all', reason: null }, machineSettings: { scope: 'own', reason: null },
      runsCancel: { scope: 'own', reason: null }, raw: { scope: 'own', reason: null },
    } };
    expect(permissionOf(me, 'settings')).toEqual({ allowed: false, reason: 'Settings are unavailable while ownership is pending.' });
    expect(scopeOf(me, 'machineSettings')).toEqual({ scope: 'own', reason: null });
    expect(scopeOf(me, 'runsCancel')).toEqual({ scope: 'own', reason: null });
  });

  it('names owner, inactive membership and denied reads in user vocabulary', () => {
    expect(errorWords(new ApiError(409, { error: 'owner_pending' })).title).toContain('needs an owner');
    expect(errorWords(new ApiError(403, { error: 'not_owner' })).title).toContain('owner');
    expect(errorWords(new ApiError(409, { error: 'member_revoked' })).title).toContain('no longer active');
    expect(errorWords(new ApiError(403, { error: 'forbidden' })).title).toContain('admin');
  });

  it('keeps missing permission fields closed', () => {
    const incomplete = { ...admin, permissions: undefined } as unknown as Me;
    expect(permissionOf(incomplete, 'backups').allowed).toBe(false);
    expect(scopeOf(incomplete, 'runsCancel').scope).toBe('none');
  });
});
