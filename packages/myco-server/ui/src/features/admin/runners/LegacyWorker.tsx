import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, ConfirmDialog, StatusChip } from '../../../design';
import { useProjects } from '../../../hooks/use-projects';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { postJson, type WorkerRow } from '../../../lib/api';
import { formatRelative } from '../../../lib/format';
import { LEGACY_WORKER_LABEL, agentsWords, lastClaimWords, taskWords } from '../workers';

export async function refreshFleet(client: ReturnType<typeof useQueryClient>) {
  await Promise.all(['runners', 'status', 'runs', 'run', 'task-start'].map(key => client.invalidateQueries({ queryKey: [key] })));
}

/** Forgetting a contact changes only the remembered inventory; another authenticated contact makes it reappear. */
export function LegacyWorker({ worker, name, stale = false }: { worker: WorkerRow; name: string; stale?: boolean }) {
  const client = useQueryClient();
  const projects = useProjects();
  const project = worker.busy === null ? null : projects.data?.projects.find(row => row.projectId === worker.busy!.projectId)?.name ?? null;
  const claim = lastClaimWords(worker);
  const [confirm, setConfirm] = useState(false);
  const allowed = permissionOf(useMe().data, 'runners').allowed;
  const forget = useMutation({ mutationFn: () => postJson(`/api/workers/legacy/${encodeURIComponent(worker.credentialId)}/forget`, {}),
    onSuccess: async () => { setConfirm(false); await refreshFleet(client); } });
  const offline = worker.busy === null && !worker.recent;
  return <article className="rounded-card border border-line p-s3" data-legacy-worker={worker.credentialId}>
    <div className="flex flex-wrap items-center justify-between gap-s2">
      <div className="flex flex-wrap items-center gap-s2"><h3 className="t-h3 text-ink">{name}</h3><StatusChip>{worker.busy !== null ? 'Busy' : worker.lastSeenAt === 0 ? 'Never contacted' : worker.recent ? 'Online' : 'Offline'}</StatusChip></div>
      {allowed && !stale && offline && <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Forget this worker</Button>}
    </div>
    <p className="mt-s1 t-small text-ink-2">Register a runner here; once current work finishes, uninstall the legacy worker before installing the runner service.</p>
    <details className="mt-s2 t-small text-muted"><summary className="cursor-pointer text-ink-2">Details</summary>
      <div className="mt-s2 flex flex-col gap-s2 break-words">
        <p>{LEGACY_WORKER_LABEL}</p>
        {worker.lastSeenAt > 0 && <p>{worker.recent ? 'Seen' : 'Not seen recently; last seen'} {formatRelative(worker.lastSeenAt)}.</p>}
        {worker.busy !== null && <p>Running {taskWords(worker.busy.task)}{project === null ? '' : ` in ${project}`}. Assignment valid until {new Date(worker.busy.leaseExpiresAt).toLocaleString()}.</p>}
        <p>{agentsWords(worker)}</p>
        {claim !== null && <p>{claim} This describes only the machine’s last check.</p>}
        <p>After its assigned work finishes, run <code>myco worker uninstall --server {window.location.origin}</code> on that machine before <code>myco runner install</code>. Forget only clears the remembered contact.</p>
      </div>
    </details>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Forget this worker?" confirmLabel="Forget worker"
      description="This removes its remembered contact from the inventory. It never revokes the member credential or changes membership or capture. If the worker contacts again, it reappears."
      pending={forget.isPending} error={forget.error?.message} onConfirm={() => forget.mutate()} />
  </article>;
}
