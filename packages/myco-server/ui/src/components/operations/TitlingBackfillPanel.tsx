import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { fetchJson, putJson } from '../../lib/api';

export interface BackfillProgress {
  scheduledTasksEnabled: boolean;
  backfillEnabled: boolean;
  runsPerDay: number | null;
  intervalSeconds: number;
  enabled: boolean;
  remaining: number;
  usedToday: number;
  inFlight: number;
  completedToday: number;
  failedToday: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Where the backfill stands, in the reader's words. */
export function progressWords(p: BackfillProgress): string {
  const left = p.remaining === 0 ? 'Every imported session with material has a title or an attempt.' : `${plural(p.remaining, 'imported session')} still to title.`;
  if (!p.backfillEnabled) return `${left} The backfill is stopped.`;
  if (!p.scheduledTasksEnabled) return `${left} The backfill is on but runs only while scheduled intelligence is on; turn that on in Settings.`;
  const ceiling = p.runsPerDay === null ? `${p.usedToday} started` : `${p.usedToday} of ${p.runsPerDay} started`;
  return `${left} Today: ${ceiling}, ${p.inFlight} in flight, ${p.completedToday} titled, ${p.failedToday} failed.`;
}

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high aria-busy:opacity-60';

/** Title the sessions an import brought, a few a day, newest first; stop or resume it here. */
export function TitlingBackfillPanel() {
  const queries = useQueryClient();
  const progress = useQuery({ queryKey: ['titling-backfill'], queryFn: ({ signal }) => fetchJson<BackfillProgress>('/api/titling-backfill', signal) });
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => putJson<BackfillProgress>('/api/titling-backfill', { enabled }),
    onSuccess: (data) => { queries.setQueryData(['titling-backfill'], data); void queries.invalidateQueries({ queryKey: ['settings'] }); },
  });
  const p = progress.data;
  const stopped = p !== undefined && !p.backfillEnabled;
  return (
    <Panel title="Titles for imported sessions" eyebrow="Backfill" actions={p === undefined ? undefined : (
      <button type="button" className={button} aria-busy={setEnabled.isPending} onClick={() => { if (!setEnabled.isPending) setEnabled.mutate(stopped); }}>
        {stopped ? 'Start backfill' : 'Stop backfill'}
      </button>
    )}>
      <p className="m-0 font-sans text-sm text-on-surface-variant">
        {p !== undefined
          ? progressWords(p)
          : progress.isError
            ? 'The server could not report on the backfill right now.'
            : 'Reading where the backfill stands…'}
        {' '}The daily ceiling and pace are the task's schedule under Task overrides on <Link to="/settings" className="text-primary underline">Settings</Link>; any session can still be titled from its own page.
      </p>
    </Panel>
  );
}
