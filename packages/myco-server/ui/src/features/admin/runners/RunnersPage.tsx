import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FleetQueue, FleetRun } from '@goondocks/myco-shared/runner-fleet';
import { Button, ConfirmDialog, ErrorState, Input, MoreMenu, StatusChip } from '../../../design';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { fetchJson, postJson, type RunnerRow, type WorkerRow } from '../../../lib/api';
import { formatRelative } from '../../../lib/format';
import { harnessLabel } from '../../../lib/harness';
import { runPath } from '../../../routes/nav';
import { AdminPage, AdminSection } from '../AdminFrame';
import { machineOfWorker, useMachines } from '../machines';
import { LEGACY_WORKER_LABEL, REASON_WORDS, taskWords } from '../workers';
import { LegacyWorker, refreshFleet } from './LegacyWorker';
import { QueueWarning } from './QueueWarning';

const RUNNERS_KEY = ['runners'] as const;
interface FleetAnswer { observedAt: number; runners: RunnerRow[]; legacyWorkers: WorkerRow[]; queue: FleetQueue }

/** Every machine entrusted with Myco's work, with observations separated from server controls and assignments. */
export function RunnersPage() {
  const runners = useQuery({ queryKey: RUNNERS_KEY, queryFn: ({ signal }) => fetchJson<FleetAnswer>('/api/runners', signal), refetchInterval: 15_000 });
  const permission = permissionOf(useMe().data, 'runners');
  const machines = useMachines();
  const [setup, setSetup] = useState(false);
  return (
    <AdminPage name="runners" scope="server" title="Runners" lede="Your machines run Myco’s work: learning from sessions, writing titles and keeping code maps current.">
      {runners.isError && <><ErrorState error={runners.error} onRetry={() => void runners.refetch()} /><p className="t-small text-muted">Machine and queue information is unavailable. Last check failed {formatRelative(runners.errorUpdatedAt)}.{runners.data !== undefined ? ` Last successful read ${formatRelative(runners.data.observedAt)}; the rows below are stale.` : ' Last successful read unavailable.'}</p></>}
      {runners.isPending && <p className="t-body text-muted">Loading machines…</p>}
      {runners.data !== undefined && !runners.isError && <QueueWarning queue={runners.data.queue} />}
      <AdminSection id="runners" title="Registered runners" description="A runner is a machine you’ve chosen to run Myco’s work. Its agent sign-ins stay on that machine.">
        {permission.allowed && <Button size="sm" onClick={() => setSetup(!setup)}>Add runner</Button>}
        {setup && <div className="rounded-card border border-line p-s4 t-small text-ink-2"><p>On the machine you want to use, run <code>myco runner register {window.location.origin}</code>. Open its device approval link, review the machine and approve it. If this machine has a legacy worker, let its assigned work finish and run <code>myco worker uninstall --server {window.location.origin}</code> on that machine. Then run <code>myco runner install</code> on that machine to start at login.</p><p className="mt-s2">Sign in to a supported coding agent on that machine first. Myco reports its sign-in; a model listing does not prove provider access.</p></div>}
        {runners.data?.runners.length === 0 && !runners.isError && <p className="t-body text-muted">No runners are registered. Add a machine to run Myco’s work.</p>}
        <div className="flex flex-col gap-s4">
          {runners.data?.runners.map((runner) => <RunnerCard key={runner.id} runner={runner} allowed={permission.allowed && !runners.isError} />)}
        </div>
      </AdminSection>
      <AdminSection id="legacy-workers" title={LEGACY_WORKER_LABEL} description="These machines can also run Myco’s work. Register each machine, let its work finish, then uninstall its legacy worker before installing the runner service.">
        {machines.error && <ErrorState error={machines.error} onRetry={machines.retry}><p>Machine names are unavailable.</p></ErrorState>}
        {runners.data?.legacyWorkers?.length === 0 && !runners.isError && <p className="t-small text-muted">{permission.allowed ? 'No legacy workers are remembered.' : 'None of your machines run a legacy worker.'}</p>}
        <div className="flex flex-col gap-s2">{runners.data?.legacyWorkers?.map(worker => <LegacyWorker key={worker.credentialId} worker={worker} stale={runners.isError} name={machineOfWorker(machines.machines, worker)?.name ?? worker.machineId ?? 'A machine'} />)}</div>
      </AdminSection>
    </AdminPage>
  );
}

function RunFact({ label, run }: { label: string; run: FleetRun | null }) {
  if (run === null) return null;
  return <p className="t-small text-muted"><span className="text-ink-2">{label}: </span><Link className="underline underline-offset-2" to={runPath(run.projectId, run.runId)}>{taskWords(run.task)}{run.projectName === null ? '' : ` · ${run.projectName}`}</Link> · {formatRelative(run.at)}</p>;
}

function outcome(runner: RunnerRow): string {
  if (runner.state === 'removed') return 'Removed — can no longer run work';
  if (runner.state === 'paused') return runner.busy ? 'Paused — finishing its current task' : 'Paused — waiting to resume';
  if (runner.busy) {
    const work = runner.busy.task === 'title-summary' ? 'Writing a title' : runner.busy.task === 'extract-curate' ? 'Learning from sessions' : runner.busy.task === 'canopy-map' ? 'Updating a code map' : `Running ${taskWords(runner.busy.task)}`;
    return `${work}${runner.busy.projectName ? ` for ${runner.busy.projectName}` : ''} (started ${formatRelative(runner.busy.at)})`;
  }
  if (runner.display === 'Not ready') {
    switch (runner.readiness.code ?? runner.readiness.state) {
      case 'settling': return 'Settling after waking';
      case 'updating': return 'Finishing an update';
      case 'registration': return 'Waiting for registration approval';
      case 'user_active': return 'Waiting until the machine is idle';
      case 'incompatible': return 'Agent needs an update';
      case 'not_signed_in': return 'No signed-in agent';
    }
    if (runner.offers?.length === 0 || runner.offers?.every(offer => !offer.authenticated)) return 'No signed-in agent';
    return 'Status unknown';
  }
  if (runner.display === 'Never contacted') return 'Waiting for its first check';
  if (runner.display === 'Offline') return `Not seen recently; last seen ${formatRelative(runner.lastSeenAt)}`;
  if (runner.lastCompleted) return `Last ran ${runner.lastCompleted.task === 'title-summary' ? 'a title' : runner.lastCompleted.task === 'extract-curate' ? 'learning' : taskWords(runner.lastCompleted.task)} ${formatRelative(runner.lastCompleted.at)}`;
  return 'Waiting for its next check';
}

interface DevicePreview { subject: 'member' | 'runner'; runnerName?: string; replacingRunnerId?: string | null; machineName: string; os: string; ip: string; approverIp: string; ageSeconds: number; scope: string; expiresAt: number }

type Control = 'rename' | 'pause' | 'resume' | 'remove' | 'recredential';
function RunnerCard({ runner, allowed }: { runner: RunnerRow; allowed: boolean }) {
  const client = useQueryClient();
  const [control, setControl] = useState<Control | null>(null);
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<(DevicePreview & { code: string }) | null>(null);
  const inspect = useMutation({ mutationFn: (code: string) => postJson<DevicePreview>('/api/device/preview', { user_code: code }),
    onSuccess: (details, code) => setPreview({ ...details, code }) });
  const update = useMutation({ mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/update`, {}), onSuccess: () => refreshFleet(client) });
  const change = useMutation({ mutationFn: () => postJson(`/api/runners/${encodeURIComponent(runner.id)}/${control}`, control === 'rename' ? { name: value } : control === 'recredential' ? { user_code: value } : {}),
    onSuccess: async () => { setControl(null); await refreshFleet(client); } });
  const result = runner.lastResult;
  const blocked = runner.blockedVersion;
  const state = runner.updateState;
  const resultWords = result === null ? 'No update result reported.' : `${result.result === 'updated' ? 'Updated' : result.result === 'no_update' ? 'Already current' : result.result === 'rolled_back' ? 'Rolled back' : result.result === 'refused' ? 'Update refused' : 'Update failed'} · ${result.fromVersion} → ${result.toVersion} · ${formatRelative(result.at)}${result.reason ? ` · ${result.reason}` : ''}`;
  const descriptions: Record<Control, string> = {
    rename: 'Give this machine a name you recognize. Use letters, numbers, dots, underscores or hyphens.',
    pause: 'This machine will take no new work. Its assigned run can finish.',
    resume: 'This machine may take new work once it checks in and is ready.',
    remove: 'This removes the machine’s authority to take work and save results immediately. An unfinished run can retry on another machine after its assignment expires. The remote process may still be running; this does not terminate it.',
    recredential: `On this machine, run myco runner register ${window.location.origin} --replace --name ${runner.name}. Enter its device code here to approve replacement authority on this same runner ID. Current authority ends on approval, including any assigned run; its work can retry after the assignment expires.`,
  };
  const open = (action: Control) => { change.reset(); inspect.reset(); setPreview(null); setValue(action === 'rename' ? runner.name : ''); setControl(action); };
  const replacementReady = preview !== null && preview.code === value && preview.subject === 'runner' && preview.runnerName === runner.name && preview.replacingRunnerId === runner.id;
  const tone = runner.display === 'Busy' || runner.display === 'Online' ? 'ok' : runner.display === 'Not ready' ? 'warn' : 'neutral';
  return (
    <article className="rounded-card border border-line bg-surface-1 p-s4" data-runner={runner.id}>
      <div className="flex flex-col gap-s3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-s2">
            <h3 className="t-h3 break-words text-ink">{runner.name}</h3>
            <StatusChip tone={tone}>{runner.display}</StatusChip>
            {runner.state === 'paused' && runner.busy !== null && <StatusChip>Busy · draining</StatusChip>}
          </div>
          <p className="mt-s1 t-small text-ink-2">{runner.awaitingReplacement && runner.state === 'enabled' ? 'Waiting for the replacement to check in' : outcome(runner)}</p>
          <p className="mt-s1 t-meta text-muted">{runner.version ?? 'Version unavailable'}{runner.updateAvailable === true && <span className="ml-s2 text-ink">Update available</span>}</p>
          {runner.updateRequest !== null && <p role="status" className="mt-s1 t-small text-muted">Update requested · {runner.busy === null ? 'waiting for the machine' : 'waiting for the current task to finish'}.</p>}
          {state?.phase === 'updating' && <p role="status" className="mt-s1 t-small text-ink">Updating · waiting to resume work</p>}
        </div>
        {allowed && runner.state !== 'removed' && <div className="flex shrink-0 items-center gap-s2">
          {runner.updateAvailable === true && <Button size="sm" disabled={!runner.connected || runner.channel === null || runner.updateRequest !== null || update.isPending} onClick={() => update.mutate()}>{update.isPending ? 'Requesting…' : blocked != null ? 'Clear block and update' : 'Update now'}</Button>}
          <MoreMenu label={`More actions for ${runner.name}`} items={[
            { label: 'Rename', onSelect: () => open('rename') },
            { label: runner.state === 'paused' ? 'Resume' : 'Pause', onSelect: () => open(runner.state === 'paused' ? 'resume' : 'pause') },
            { label: 'Replace registration', onSelect: () => open('recredential') },
            { label: 'Remove', onSelect: () => open('remove'), tone: 'danger' },
          ]} />
        </div>}
      </div>
      {update.isError && <ErrorState error={update.error} onRetry={() => update.mutate()} />}
      <details className="mt-s3 border-t border-line pt-s3 t-small text-muted"><summary className="min-h-tap content-center cursor-pointer text-ink-2">Details</summary>
        <div className="mt-s3 flex flex-col gap-s2 break-words">
          {runner.busy === null && runner.lastAttempted === null && runner.lastCompleted === null && runner.lastFailed === null ? <p>No runs yet.</p> : <>
            <RunFact label="Last completed" run={runner.lastCompleted} />
            <RunFact label="Last failed" run={runner.lastFailed} />
            <RunFact label="Last attempted" run={runner.lastAttempted} />
          </>}
          {runner.busy && <><RunFact label="Current task" run={runner.busy} /><p>Assignment valid until {new Date(runner.busy.leaseExpiresAt).toLocaleString()}.</p></>}
          {runner.offers === null ? <p>Agent sign-in status unavailable.</p> : runner.offers.length === 0 ? <p>No agents reported.</p> : <div>{runner.offers.map(offer => <p key={offer.id}>{harnessLabel(offer.id)} · {offer.authenticated ? 'Signed in' : 'Signed out'}{offer.profile && ` · ${offer.profile.model === 'none' ? 'Default model' : 'Model selection available'} · effort choices: ${offer.profile.efforts.join(', ') || 'none reported'}`}</p>)}<span title="A listed model does not confirm provider access or quota." aria-label="Provider access information">ⓘ</span></div>}
          {runner.models?.map(model => <p key={model.harness}>{harnessLabel(model.harness)} models: {model.available ? model.source ?? 'source unavailable' : 'listing unavailable'} · listed {formatRelative(model.fetchedAt)} · received {formatRelative(model.receivedAt)} · {model.fresh ? 'recent listing' : 'stale listing'}</p>)}
          {(runner.capabilities?.length || runner.labels?.length || runner.preference) && <p>{runner.capabilities?.length ? `Capabilities: ${runner.capabilities.join(', ')}. ` : ''}{runner.labels?.length ? `Labels: ${runner.labels.join(', ')}. ` : ''}{runner.preference ? `Preference: ${runner.preference}.` : ''}</p>}
          {runner.lastReason !== null && runner.lastReason in REASON_WORDS && <p>Last check for work: {REASON_WORDS[runner.lastReason as keyof typeof REASON_WORDS]}.</p>}
          {runner.display === 'Not ready' && <p>Readiness: {runner.readiness.reason}</p>}
          {runner.offers !== null && runner.offersObservedAt != null && <p>Agent status reported {formatRelative(runner.offersObservedAt)}.</p>}
          {runner.os && <p>Operating system: {runner.os}{runner.arch ? ` · ${runner.arch}` : ''}.</p>}
          {runner.channel && <p>Release channel: {runner.channel}.</p>}
          {runner.updateAvailable === true && <p>Available release: {runner.latestVersion}.</p>}
          {runner.lastSeenAt !== null && <p>Last checked in {formatRelative(runner.lastSeenAt)}.</p>}
          {runner.lastCheckAt !== null && <p>Last update check {formatRelative(runner.lastCheckAt)}.</p>}
          {runner.updateMetadataUnavailable && <p>Update metadata unavailable.</p>}
          {result !== null && <p>{resultWords}</p>}
          {state != null && <p>{state.phase === 'updating' ? 'Updating' : state.phase === 'probation' ? 'Checking update health' : 'Finishing update cleanup'} · since {formatRelative(state.since)}{state.reason ? ` · ${state.reason}` : ''}</p>}
          {blocked != null && <p>Blocked release: {blocked.version} · {blocked.until > Date.now() ? 'retry after' : 'block expired'} {new Date(blocked.until).toLocaleString()} · {blocked.reason}</p>}
          {runner.channel === null && runner.state !== 'removed' && <p>Dashboard updates require a reported release channel.</p>}
          <p>Runner ID: <code>{runner.id}</code></p>
        </div>
      </details>
      <ConfirmDialog open={control !== null} onOpenChange={isOpen => { if (!isOpen) setControl(null); }} title={control === null ? '' : `${control === 'rename' ? 'Rename' : control === 'recredential' ? 'Replace registration for' : control === 'pause' ? 'Pause' : control === 'resume' ? 'Resume' : 'Remove'} ${runner.name}?`}
        description={control === null ? '' : descriptions[control]} confirmLabel={control === 'recredential' ? 'Approve replacement' : control === 'rename' ? 'Save name' : control === 'pause' ? 'Pause runner' : control === 'resume' ? 'Resume runner' : 'Remove runner'}
        tone={control === 'remove' || control === 'recredential' ? 'danger' : 'primary'} pending={change.isPending} error={change.error?.message}
        confirmDisabled={control === 'rename' ? !/^[A-Za-z0-9._-]{1,64}$/.test(value) : control === 'recredential' && !replacementReady} onConfirm={() => change.mutate()}>
        {(control === 'rename' || control === 'recredential') && <label className="flex flex-col gap-s2 t-small text-ink-2">{control === 'rename' ? 'Machine name' : 'Device code'}<Input autoFocus value={value} onChange={e => { setValue(control === 'recredential' ? e.target.value.toUpperCase() : e.target.value); setPreview(null); inspect.reset(); }} /></label>}
        {control === 'recredential' && <div className="mt-s3 flex flex-col gap-s2 t-small text-ink-2">
          <Button size="sm" variant="secondary" disabled={!value.trim() || inspect.isPending} onClick={() => inspect.mutate(value)}>{inspect.isPending ? 'Checking…' : 'Check machine'}</Button>
          {inspect.isError && <p role="alert" className="text-bad">{inspect.error.message}</p>}
          {preview?.code === value && <>
            <p>Request: {preview.subject === 'runner' ? `Runner named ${preview.runnerName ?? 'unnamed'}` : 'Member sign-in'}</p>
            <p>Machine: {preview.machineName}</p><p>Operating system: {preview.os}</p><p>Request source: {preview.ip}</p><p>Your IP address: {preview.approverIp}</p>
            {preview.subject !== 'runner' || preview.runnerName !== runner.name || preview.replacingRunnerId !== runner.id ? <p role="alert" className="text-bad">This request does not match {runner.name}. Start a replacement request for this runner.</p> : <p>Approving ends the current registration, including its assigned work. The replacement keeps this runner’s history and ID.</p>}
          </>}
        </div>}
      </ConfirmDialog>
    </article>
  );
}
