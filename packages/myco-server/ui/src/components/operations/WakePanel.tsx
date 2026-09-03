import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Panel } from '../ui/panel';
import { postJson } from '../../lib/api';

interface JobReport { name: string; changed: number; failed: string | null }
interface TickReport { state: string; heldBy: string | null; idleMs: number | null; jobs: JobReport[]; nextWakeMs: number | null }

const STATE_WORDS: Record<string, string> = { active: 'in use', idle: 'idle', sleep: 'asleep', deep_sleep: 'in deep sleep' };

/** Each job's outcome in the reader's words: what changed, or that it did not run to the end. */
function jobWords(job: JobReport): string {
  if (job.failed !== null) return job.name === 'agent-run-retention' ? 'old run records could not be removed' : job.name === 'run-stale-sweep' ? 'runs whose runtime went away could not be closed' : `${job.name} did not finish`;
  const n = job.changed;
  const plural = n === 1 ? '' : 's';
  if (job.name === 'agent-run-retention') return `removed ${n} old run record${plural}`;
  if (job.name === 'run-stale-sweep') return `closed ${n} run${plural} whose runtime went away`;
  return `${job.name} changed ${n} row${plural}`;
}

export function reportWords(report: TickReport): string {
  const state = STATE_WORDS[report.state] ?? report.state;
  const held = report.heldBy === 'run:live' ? ' while a run is live' : '';
  const jobs = report.jobs.length === 0 ? 'Nothing was due.' : `${report.jobs.map(jobWords).join('; ')}.`;
  const next = report.nextWakeMs === null ? 'No wake is scheduled while it sleeps this deeply.' : `Next wake in ${Math.max(1, Math.round(report.nextWakeMs / 60_000))} min.`;
  return `The server is ${state}${held}. ${jobs.charAt(0).toUpperCase()}${jobs.slice(1)} ${next}`;
}

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high aria-busy:opacity-60';

/** Run the server's housekeeping now — the same tick its clock runs — and say what it did. */
export function WakePanel() {
  const queries = useQueryClient();
  const wake = useMutation({
    mutationFn: () => postJson<TickReport>('/api/wake'),
    onSuccess: () => { void queries.invalidateQueries({ queryKey: ['runs'] }); },
  });
  return (
    <Panel title="Housekeeping" eyebrow="Now" actions={
      <button type="button" className={button} aria-busy={wake.isPending} onClick={() => { if (!wake.isPending) wake.mutate(); }}>
        {wake.isPending ? 'Running…' : 'Run housekeeping now'}
      </button>
    }>
      <p className="m-0 font-sans text-sm text-on-surface-variant">
        {wake.data !== undefined
          ? reportWords(wake.data)
          : wake.isError
            ? 'The server could not run its housekeeping right now.'
            : 'Old run records are removed and runs whose runtime went away are closed on the server\'s own clock. Run it now to see the state it is in.'}
      </p>
    </Panel>
  );
}
