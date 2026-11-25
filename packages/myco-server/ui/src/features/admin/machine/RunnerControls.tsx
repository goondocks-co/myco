import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RUNNER_PAYER_LABELS, type RunnerCredentialChoices } from '@goondocks/myco-shared/runner-fleet';
import { Button, ConfirmDialog, Input, MoreMenu } from '../../../design';
import { postJson, type RunnerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { SettingRow } from '../AdminFrame';
import { refreshFleet } from '../runners/LegacyWorker';

const RUNNER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

interface DevicePreview { credentialChoices?: RunnerCredentialChoices; subject: 'member' | 'runner'; runnerName?: string; replacingRunnerId?: string | null; machineName: string; os: string; ip: string; approverIp: string }

/** One runner registration's ⋯ menu, for an admin: renaming it and approving a replacement registration on its id. */
export function RunnerMenu({ runner }: { runner: RunnerRow }) {
  const [control, setControl] = useState<'rename' | 'recredential' | null>(null);
  return (
    <>
      <MoreMenu label={`More for ${runner.name}`} items={[
        { label: 'Rename', onSelect: () => setControl('rename') },
        { label: 'Replace its registration', onSelect: () => setControl('recredential') },
      ]} />
      <RunnerControl key={control ?? 'closed'} runner={runner} control={control} onClose={() => setControl(null)} />
    </>
  );
}

/** Renaming a runner, or approving a replacement registration on the same runner id after checking its device code. */
function RunnerControl({ runner, control, onClose }: { runner: RunnerRow; control: 'rename' | 'recredential' | null; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(runner.name);
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<(DevicePreview & { code: string }) | null>(null);
  const inspect = useMutation({ mutationFn: (value: string) => postJson<DevicePreview>('/api/device/preview', { user_code: value }), onSuccess: (details, value) => setPreview({ ...details, code: value }) });
  const change = useMutation({
    mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/${control}`, control === 'rename' ? { name } : { user_code: code }),
    onSuccess: async () => { onClose(); await refreshFleet(client); },
  });
  const ready = preview !== null && preview.code === code && preview.subject === 'runner' && preview.runnerName === runner.name && preview.replacingRunnerId === runner.id;
  return (
    <ConfirmDialog
      open={control !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={control === 'rename' ? `Rename ${runner.name}?` : `Replace the registration of ${runner.name}?`}
      description={control === 'rename'
        ? 'A runner’s name uses letters, numbers, dots, underscores or hyphens.'
        : `On the machine, run myco runner register ${window.location.origin} --replace --name ${runner.name}, then enter its device code here. ${runner.name}’s current registration ends on approval, including any run it holds; that run can retry after its assignment expires. The replacement keeps ${runner.name}’s id and history, and the machine its request names becomes ${runner.name}’s machine.`}
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
          {ready ? <p>Approving ends {runner.name}’s current registration, including its assigned work.</p>
            : <p role="alert" className="text-bad">This request does not match {runner.name}. Start a replacement request for this runner.</p>}
        </>}
      </div>}
    </ConfirmDialog>
  );
}

/**
 * Removing one runner registration, on its own: it takes no new work from then on. Capture on the machine, and any other
 * runner on it, carry on; the confirmation says so.
 */
export function RemoveRunnerRow({ runner, captureContinues }: { runner: RunnerRow; captureContinues: boolean }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/remove`, {}),
    onSuccess: async () => { setOpen(false); await refreshFleet(client); },
  });
  return (
    <>
      <SettingRow
        setting="runner-remove"
        label={`Remove ${runner.name} as a runner`}
        note={`${runner.name} takes no new work and can’t save results from then on.${captureContinues ? ' What this machine captures carries on.' : ''} What it already did is kept.`}
        control={<Button size="sm" variant="secondary" onClick={() => { remove.reset(); setOpen(true); }}>Remove {runner.name}…</Button>}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => { if (!next) setOpen(false); }}
        title={`Remove ${runner.name} as a runner?`}
        description={`${runner.name} stops taking work at once. A run it holds can retry on another runner after its assignment expires; the process on the machine isn’t ended.${captureContinues ? ' Capture on this machine continues; stop it separately below.' : ''} What it already did is kept.`}
        confirmLabel={`Remove ${runner.name}`}
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
