import { useState } from 'react';
import { useLeaveHost, type HostMembershipHost } from '../../hooks/use-host-membership';
import { leaveHostConfirmMessage, membershipErrorCopy } from '../../lib/membership-copy';

/**
 * Leave-host action — confirm, mutate, inline error. Shared by the joined-
 * hosts list (`HostCard`, `pages/Team/HostTab.tsx`) and the host detail
 * slideout (`HostDetailPanel.tsx`) so leaving a host is ONE flow regardless
 * of which surface it's triggered from (E-4 W1 Task T5 requirement — reuse,
 * don't fork the confirm string or the mutation call).
 */
export function LeaveHostControl({ host }: { host: HostMembershipHost }) {
  const leave = useLeaveHost();
  const [error, setError] = useState<string | null>(null);

  // Leaving with attached projects is refused server-side (the attach refs and
  // the unrecoverable bearer would be destroyed), so the control doesn't offer
  // it — mirroring how the Detach control gates on an in-flight move.
  const blocked = host.projects.length > 0;

  const handleLeave = async () => {
    if (!window.confirm(leaveHostConfirmMessage(host.label))) return;
    setError(null);
    try {
      await leave.mutateAsync(host.host_id);
    } catch (err) {
      setError(membershipErrorCopy(err));
    }
  };

  return (
    <div className="flex items-center justify-between gap-2">
      {error && <p className="text-xs text-terracotta m-0">{error}</p>}
      {blocked && !error && (
        <p className="text-xs text-on-surface-variant m-0">Detach the attached project{host.projects.length === 1 ? '' : 's'} first, then leave.</p>
      )}
      <button
        type="button"
        disabled={leave.isPending || blocked}
        onClick={handleLeave}
        className="ml-auto text-xs text-on-surface-variant hover:text-terracotta-text transition-colors disabled:opacity-50"
      >
        {leave.isPending ? 'Leaving…' : 'Leave host'}
      </button>
    </div>
  );
}
