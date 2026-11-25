import { useState } from 'react';
import { REJOIN_FOR_ADMIN } from '@goondocks/myco-shared/member-protocol';
import { Button, ConfirmDialog, MoreMenu } from '../../../design';
import { refusalText, useAccessActions } from '../../../hooks/use-access';
import { scopeOf, useMe } from '../../../hooks/use-me';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { Machine } from '../machines';
import { canRename } from '../people/rename';
import { RenameMachineDialog, type RenameTarget } from '../people/RenameMachineDialog';

/** The machine's ⋯ menu beside its name: Rename for its sign-ins, an admin's on any machine and a member's on their own. */
export function MachineMenu({ claim }: { claim: Machine | null }) {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const machines = scopeOf(me.data, 'machines');
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  if (claim === null || machines.scope === 'none' || !canRename(claim, viewerId, machines.scope === 'all')) return null;
  return (
    <>
      <MoreMenu label={`More for ${claim.name}`} items={[{ label: 'Rename', onSelect: () => setRenaming({ id: claim.machineId!, name: claim.name, named: claim.named }) }]} />
      <RenameMachineDialog machine={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}

/**
 * Stopping the machine capturing: its sign-ins end, so it sends nothing more. Runners on it are removed on their own, in
 * their own cards; this says that they carry on. What it already sent is kept.
 */
export function StopCapturePart({ claim, runnersContinue }: { claim: Machine | null; runnersContinue: readonly string[] }) {
  const stop = useAccessActions().stopMachine;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (claim === null || claim.liveCredentialCount === 0 || claim.machineId === null) return null;
  const several = runnersContinue.length > 1;
  const continues = runnersContinue.length === 0 ? ''
    : ` ${runnersContinue.join(' and ')} ${several ? 'stay' : 'stays'} registered as ${several ? 'runners' : 'a runner'}; removing ${several ? 'them' : 'it'} is a separate action.`;
  const confirm = () => {
    setError(null);
    stop.mutate(claim.machineId!, {
      onSuccess: (outcome) => { if (outcome.revoked > 0) setOpen(false); else setError('No sign-in was stopped. It may have ended, or you may no longer be allowed to stop it.'); },
      onError: (failure) => setError(refusalText(failure)),
    });
  };
  return (
    <AdminSection id="stop-capture" title="Stop it capturing">
      <RowCard label="Stop it capturing">
        <SettingRow
          label="Stop it capturing"
          note={claim.canStop ? `Its sign-ins end, so it sends nothing more.${continues} What it already sent is kept.` : (claim.stopReason ?? 'Stopping it is unavailable to you.')}
          control={claim.canStop ? <Button variant="secondary" onClick={() => { setError(null); stop.reset(); setOpen(true); }}>Stop capturing…</Button> : <span />}
        />
      </RowCard>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => { if (!next) setOpen(false); }}
        title={`Stop ${claim.name} capturing?`}
        description={`Its sign-ins end at once, so it sends nothing more. ${REJOIN_FOR_ADMIN}${continues} What it already sent stays.`}
        confirmLabel="Stop capturing"
        pending={stop.isPending}
        error={error}
        onConfirm={confirm}
      />
    </AdminSection>
  );
}
