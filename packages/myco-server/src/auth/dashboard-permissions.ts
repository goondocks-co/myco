import { authorize, type AuthorizationSubject, type ResourceKind, type Action } from './authorization.js';

/** The dashboard projects the same policy that admits its requests. */
export function dashboardPermissions(subject: AuthorizationSubject) {
  const can = (kind: ResourceKind, action: Action, evidence: Record<string, unknown> = {}) => authorize(subject, action, {
    kind, deploymentId: subject.deploymentId, exists: true, ...evidence,
  });
  const permission = (allowed: boolean, reason: string) => ({ allowed, reason: allowed ? null : reason });
  const scoped = (all: boolean, own: boolean, reason: string) => ({ scope: all ? 'all' as const : own ? 'own' as const : 'none' as const, reason: all ? null : reason });
  return {
    settings: permission(can('settings', 'admin'), 'An administrator can change server settings.'),
    keys: permission(can('secret', 'admin'), 'An administrator can manage keys.'),
    people: permission(can('member', 'admin'), 'An administrator can invite and manage members. Only the owner can manage another administrator.'),
    roles: permission(can('member', 'owner'), 'Only the owner can change administrator access or transfer ownership.'),
    projects: permission(can('project', 'admin'), 'An administrator can manage Projects.'),
    backups: permission(can('backup', 'admin'), 'An administrator can manage backups. Backups include raw uploads.'),
    machines: scoped(can('machine', 'edit'), can('machine', 'edit', { ownerMemberId: subject.memberId }), 'You can manage only your own machines.'),
    machineSettings: scoped(can('machine-settings', 'claimant.edit'), can('machine-settings', 'claimant.edit', { claimantMemberId: subject.memberId }), 'Only the member who claimed this machine can change which folders are recorded or connect repositories.'),
    runsCancel: scoped(can('run', 'cancel'), can('run', 'cancel', { requestedBy: subject.memberId }), 'You can cancel only runs you requested.'),
    raw: { scope: can('raw', 'read', { uploader: true }) ? 'own' as const : 'none' as const, reason: 'Raw uploads are private to the member who uploaded them, including for owners and administrators.' },
  };
}
