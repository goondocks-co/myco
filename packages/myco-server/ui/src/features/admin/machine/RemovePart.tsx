import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { REJOIN_FOR_ADMIN } from '@goondocks/myco-shared/member-protocol';
import { RUNNER_PAYER_LABELS, type RunnerCredentialChoices } from '@goondocks/myco-shared/runner-fleet';
import { Button, ConfirmDialog, Input, MoreMenu, type MoreMenuItem } from '../../../design';
import { refusalText, useAccessActions } from '../../../hooks/use-access';
import { scopeOf, useIsAdmin, useMe } from '../../../hooks/use-me';
import { postJson, type RunnerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { Machine } from '../machines';
import { canRename } from '../people/rename';
import { RenameMachineDialog, type RenameTarget } from '../people/RenameMachineDialog';
import { refreshFleet } from '../runners/LegacyWorker';

const RUNNER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

interface DevicePreview { credentialChoices?: RunnerCredentialChoices; subject: 'member' | 'runner'; runnerName?: string; replacingRunnerId?: string | null; machineName: string; os: string; ip: string; approverIp: string }

/**
 * The machine's ⋯ menu beside its name: Rename for its sign-ins (an admin's on any machine, a member's on their own),
 * and for an admin, renaming its runner and replacing the runner's registration.
 */
export function MachineMenu({ claim, runner }: { claim: Machine | null; runner: RunnerRow | null }) {
  const me = useMe();
  const admin = useIsAdmin();
  const viewerId = me.data?.member?.id ?? null;
  const machines = scopeOf(me.data, 'machines');
  const [renaming, setRenaming] = useState<RenameTarget | null>(null);
  const [control, setControl] = useState<'rename' | 'recredential' | null>(null);
  const live = runner !== null && runner.state !== 'removed';
  const items: MoreMenuItem[] = [
    ...(claim !== null && machines.scope !== 'none' && canRename(claim, viewerId, machines.scope === 'all') ? [{ label: 'Rename', onSelect: () => setRenaming({ id: claim.machineId!, name: claim.name, named: claim.named }) }] : []),
    ...(admin && live ? [{ label: claim === null ? 'Rename' : 'Rename its runner', onSelect: () => setControl('rename') }, { label: 'Replace its runner registration', onSelect: () => setControl('recredential') }] : []),
  ];
  if (items.length === 0) return null;
  return (
    <>
      <MoreMenu label={`More for ${claim?.name ?? runner?.name ?? 'this machine'}`} items={items} />
      <RenameMachineDialog machine={renaming} onClose={() => setRenaming(null)} />
      {live && <RunnerControl runner={runner} control={control} onClose={() => setControl(null)} />}
    </>
  );
}

/** Renaming a runner, or approving a replacement registration on the same runner id after checking its device code. */
function RunnerControl({ runner, control, onClose }: { runner: RunnerRow; control: 'rename' | 'recredential' | null; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(runner.name);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<(DevicePreview & { code: string }) | null>(null);
  const inspect = useMutation({ mutationFn: (code: string) => postJson<DevicePreview>('/api/device/preview', { user_code: code }), onSuccess: (details, code) => setPreview({ ...details, code }) });
  const change = useMutation({
    mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/${control}`, control === 'rename' ? { name } : { user_code: code }),
    onSuccess: async () => { onClose(); await refreshFleet(client); },
  });
  const ready = preview !== null && preview.code === code && preview.subject === 'runner' && preview.runnerName === runner.name && preview.replacingRunnerId === runner.id;
  const reset = (open: boolean) => { if (!open) { onClose(); change.reset(); inspect.reset(); setPreview(null); setName(runner.name); setCode(''); } };
  return (
    <ConfirmDialog
      open={control !== null}
      onOpenChange={reset}
      title={control === 'rename' ? `Rename ${runner.name}?` : `Replace the runner registration for ${runner.name}?`}
      description={control === 'rename'
        ? 'A runner’s name uses letters, numbers, dots, underscores or hyphens.'
        : `On this machine, run myco runner register ${window.location.origin} --replace --name ${runner.name}, then enter its device code here. The current registration ends on approval, including any run it holds; that run can retry after its assignment expires.`}
      confirmLabel={control === 'rename' ? 'Save name' : 'Approve replacement'}
      tone={control === 'rename' ? 'primary' : 'danger'}
      pending={change.isPending}
      error={change.error?.message}
      confirmDisabled={control === 'rename' ? !RUNNER_NAME.test(name) : !ready}
      onConfirm={() => change.mutate()}
    >
      <label className="flex flex-col gap-s2 t-small text-ink-2">{control === 'rename' ? 'Runner name' : 'Device code'}
        <Input autoFocus value={control === 'rename' ? name : code} onChange={(event) => { if (control === 'rename') setName(event.target.value); else setCode(event.target.value.toUpperCase()); setPreview(null); inspect.reset(); }} />
      </label>
      {control === 'recredential' && <div className="mt-s3 flex flex-col gap-s2 t-small text-ink-2">
        <Button size="sm" variant="secondary" disabled={!code.trim() || inspect.isPending} onClick={() => inspect.mutate(code)}>{inspect.isPending ? 'Checking…' : 'Check machine'}</Button>
        {inspect.isError && <p role="alert" className="text-bad">{inspect.error.message}</p>}
        {preview?.code === code && <>
          <p>Request: {preview.subject === 'runner' ? `Runner named ${preview.runnerName ?? 'unnamed'}` : 'Member sign-in'}</p>
          {Object.entries(preview.credentialChoices ?? {}).map(([agent, choice]) => <p key={agent}>{harnessLabel(agent)} paid by: {RUNNER_PAYER_LABELS[choice]}</p>)}
          <p>Machine: {preview.machineName}</p><p>Operating system: {preview.os}</p><p>Request source: {preview.ip}</p><p>Your IP address: {preview.approverIp}</p>
          {ready ? <p>Approving ends the current registration, including its assigned work. The replacement keeps this runner’s history and id.</p>
            : <p role="alert" className="text-bad">This request does not match {runner.name}. Start a replacement request for this runner.</p>}
        </>}
      </div>}
    </ConfirmDialog>
  );
}

/**
 * Remove this machine: its sign-ins stopped, so it captures nothing more, and its runner removed, so it takes no more
 * work, each behind the one confirmation. What it already sent is kept.
 */
export function RemovePart({ claim, runner }: { claim: Machine | null; runner: RunnerRow | null }) {
  const admin = useIsAdmin();
  const client = useQueryClient();
  const stop = useAccessActions().stopMachine;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stoppable = claim !== null && claim.liveCredentialCount > 0 && claim.machineId !== null && claim.canStop;
  const removable = admin && runner !== null && runner.state !== 'removed';
  const removeRunner = useMutation({ mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner!.id)}/remove`, {}) });
  if (!stoppable && !removable) {
    if (claim !== null && claim.liveCredentialCount > 0 && !claim.canStop) {
      return <AdminSection id="remove" title="Remove this machine"><p className="t-small text-muted">{claim.stopReason ?? 'Removing this machine is unavailable.'}</p></AdminSection>;
    }
    return null;
  }
  const what = [stoppable ? 'its sign-ins stop, so it captures nothing more' : null, removable ? 'it stops being a runner and takes no new work' : null].filter(Boolean).join(', and ');
  const confirm = async () => {
    setError(null);
    try {
      if (stoppable) {
        const outcome = await stop.mutateAsync(claim.machineId!);
        if (outcome.revoked === 0) { setError('No sign-in was stopped. It may have ended, or you may no longer be allowed to stop it.'); return; }
      }
      if (removable) await removeRunner.mutateAsync();
      await refreshFleet(client);
      setOpen(false);
    } catch (failure) {
      setError(refusalText(failure));
    }
  };
  return (
    <AdminSection id="remove" title="Remove this machine">
      <RowCard label="Remove this machine">
        <SettingRow
          label={stoppable && removable ? 'Sign it out and stop its work' : stoppable ? 'Sign it out' : 'Stop its work'}
          note={`At once, ${what}. What it already sent is kept.`}
          control={<Button variant="secondary" onClick={() => { setError(null); setOpen(true); }}>Remove…</Button>}
        />
      </RowCard>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => { if (!next) setOpen(false); }}
        title={`Remove ${claim?.name ?? runner?.name ?? 'this machine'}?`}
        description={`At once, ${what}.${stoppable ? ` ${REJOIN_FOR_ADMIN}` : ''}${removable ? ' A run it holds can retry on another runner after its assignment expires; the process on the machine isn’t ended.' : ''} What it already sent stays.`}
        confirmLabel="Remove"
        pending={stop.isPending || removeRunner.isPending}
        error={error}
        onConfirm={() => void confirm()}
      />
    </AdminSection>
  );
}
