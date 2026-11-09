import type { useQueryClient } from '@tanstack/react-query';
import { StatusChip } from '../../../design';
import { useProjects } from '../../../hooks/use-projects';
import type { WorkerRow } from '../../../lib/api';
import { formatRelative } from '../../../lib/format';
import { LEGACY_WORKER_LABEL, agentsWords, lastClaimWords, taskWords } from '../workers';

export async function refreshFleet(client: ReturnType<typeof useQueryClient>) {
  await Promise.all(['runners', 'status', 'runs', 'run', 'task-start'].map(key => client.invalidateQueries({ queryKey: [key] })));
}

/** A legacy worker's remembered contact; it ages out after thirty days without contact and reappears if the machine reports again. */
export function LegacyWorker({ worker, name }: { worker: WorkerRow; name: string }) {
  const projects = useProjects();
  const project = worker.busy === null ? null : projects.data?.projects.find(row => row.projectId === worker.busy!.projectId)?.name ?? null;
  const claim = lastClaimWords(worker);
  return <article className="rounded-card border border-line p-s3" data-legacy-worker={worker.credentialId}>
    <div className="flex flex-wrap items-center justify-between gap-s2">
      <div className="flex flex-wrap items-center gap-s2"><h3 className="t-h3 text-ink">{name}</h3><StatusChip>{worker.busy !== null ? 'Busy' : worker.lastSeenAt === 0 ? 'Never contacted' : worker.recent ? 'Online' : 'Offline'}</StatusChip></div>
    </div>
    <p className="mt-s1 t-small text-ink-2">Register a runner here; once current work finishes, uninstall the legacy worker before installing the runner service.</p>
    <details className="mt-s2 t-small text-muted"><summary className="min-h-tap content-center cursor-pointer text-ink-2">Details</summary>
      <div className="mt-s2 flex flex-col gap-s2 break-words">
        <p>{LEGACY_WORKER_LABEL}</p>
        {worker.lastSeenAt > 0 && <p>{worker.recent ? 'Seen' : 'Not seen recently; last seen'} {formatRelative(worker.lastSeenAt)}.</p>}
        {worker.busy !== null && <p>Running {taskWords(worker.busy.task)}{project === null ? '' : ` in ${project}`}. Assignment valid until {new Date(worker.busy.leaseExpiresAt).toLocaleString()}.</p>}
        <p>{agentsWords(worker)}</p>
        {claim !== null && <p>{claim} This describes only the machine’s last check.</p>}
        <p>After its assigned work finishes, run <code>myco worker uninstall --server {window.location.origin}</code> on that machine before <code>myco runner install</code>.</p>
      </div>
    </details>
  </article>;
}
