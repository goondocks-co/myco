import { useState } from 'react';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Button } from '../../../design';
import { useIsAdmin, useMe } from '../../../hooks/use-me';
import { AdminPage, AdminSection } from '../AdminFrame';
import { useMachines } from '../machines';
import { useMemberNames } from '../members';
import { InviteDialog, type InviteTarget } from './InviteDialog';
import { MachineList } from './MachineList';

/**
 * `/me/machines`: the signed-in member's own machines, for every member, each
 * with its settings, what it wrote, and Stop. An admin adds another machine
 * from here; a member is told who can.
 */
export function MyMachinesPage() {
  const me = useMe();
  const admin = useIsAdmin();
  const viewerId = me.data?.member?.id ?? null;
  const machines = useMachines();
  const nameOf = useMemberNames();
  const [invite, setInvite] = useState<InviteTarget | null>(null);
  const own = machines.machines.filter((machine) => machine.memberId === viewerId);

  return (
    <AdminPage
      name="my-machines"
      title="My machines"
      lede="The machines you signed in to this server from, and whether each may write now."
      actions={admin && viewerId !== null
        ? <Button variant="primary" onClick={() => setInvite({ kind: 'machine', memberId: viewerId })}>{INVITE_CONTROLS.button}</Button>
        : undefined}
    >
      <AdminSection id="machines" title="Machines">
        <MachineList
          machines={own}
          viewerId={viewerId}
          nameOf={nameOf}
          showOwner={false}
          paging={machines}
          empty="None of your machines has signed in yet."
        />
        {!admin && (
          <p className="t-small text-muted" data-add-machine-hint="">
            To add a machine, an admin creates a one-time link on {INVITE_CONTROLS.page}; you run <code className="t-mono text-ink-2">myco login &lt;link&gt;</code> on the new machine.
          </p>
        )}
      </AdminSection>
      <InviteDialog target={invite} onClose={() => setInvite(null)} people={viewerId === null ? [] : [{ id: viewerId, name: 'You' }]} />
    </AdminPage>
  );
}
