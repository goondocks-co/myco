import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { fetchJson, putJson } from '../../lib/api';

export interface BackfillProgress {
  scheduledTasksEnabled: boolean;
  backfillEnabled: boolean;
  runsPerDay: number | null;
  intervalSeconds: number;
  runIn: string[];
  overlap: 'skip' | 'queue';
  enabled: boolean;
  remaining: number;
  owed: number;
  usedToday: number;
  inFlight: number;
  completedToday: number;
  failedToday: number;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATE_WORDS: Record<string, string> = { active: 'in use', idle: 'idle', sleep: 'asleep' };

/** The states the backfill dispatches in and how often, in the reader's words. */
export function policyWords(p: Pick<BackfillProgress, 'runIn' | 'intervalSeconds'>): string {
  const states = p.runIn.map((s) => STATE_WORDS[s] ?? s);
  const when = states.length === 0 ? 'in no state' : `while the server is ${states.length === 1 ? states[0] : `${states.slice(0, -1).join(', ')} or ${states[states.length - 1]}`}`;
  const minutes = Math.max(1, Math.round(p.intervalSeconds / 60));
  return `Dispatches ${when}, at most once every ${minutes} min.`;
}

/** Where titling stands, in the reader's words: sessions captured live converge on their own, imported sessions wait for the backfill switch, and the Deployment's scheduled-intelligence switch stops both. */
export function progressWords(p: BackfillProgress): string {
  const owed = p.owed === 0 ? 'No ended live sessions are waiting for a title.'
    : `${plural(p.owed, 'ended live session')} waiting for a title${p.scheduledTasksEnabled ? '; these are titled automatically' : ''}.`;
  const left = p.remaining === 0 ? 'No fully parsed imported sessions are waiting for a title attempt.' : `${plural(p.remaining, 'fully parsed imported session')} waiting for a title attempt.`;
  if (!p.scheduledTasksEnabled) return `${owed} ${left} Automatic titling is off while scheduled intelligence is off; turn that on in Settings.`;
  const imported = p.backfillEnabled ? left : `${left} The imported-session backfill is stopped.`;
  const ceiling = p.runsPerDay === null ? `${p.usedToday} started` : `${p.usedToday} of ${p.runsPerDay} started`;
  return `${owed} ${imported} ${policyWords(p)} Today: ${ceiling}, ${p.inFlight} in flight, ${p.completedToday} titled, ${p.failedToday} failed.`;
}

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high aria-busy:opacity-60';

/** Title every ended session a few a day, newest first, while scheduled intelligence is on: live sessions on their own, imported ones while the backfill is on; stop or resume that backfill here. */
export function TitlingBackfillPanel() {
  const queries = useQueryClient();
  const progress = useQuery({ queryKey: ['titling-backfill'], queryFn: ({ signal }) => fetchJson<BackfillProgress>('/api/titling-backfill', signal) });
  const setEnabled = useMutation({
    mutationFn: (enabled: boolean) => putJson<BackfillProgress>('/api/titling-backfill', { enabled }),
    onSuccess: (data) => { queries.setQueryData(['titling-backfill'], data); void queries.invalidateQueries({ queryKey: ['settings'] }); },
  });
  const p = progress.data;
  const stopped = p !== undefined && !p.backfillEnabled;
  const actions = p !== undefined
    ? (
      <button type="button" className={button} aria-busy={setEnabled.isPending} onClick={() => { if (!setEnabled.isPending) setEnabled.mutate(stopped); }}>
        {stopped ? 'Start backfill' : 'Stop backfill'}
      </button>
    )
    : progress.isError
      ? <button type="button" className={button} aria-busy={progress.isFetching} onClick={() => { if (!progress.isFetching) void progress.refetch(); }}>Try again</button>
      : undefined;
  return (
    <Panel title="Session titles" eyebrow="Backfill" actions={actions}>
      <p className="m-0 font-sans text-sm text-on-surface-variant">
        {p !== undefined
          ? progressWords(p)
          : progress.isError
            ? 'The server could not report on the backfill right now.'
            : 'Reading where the backfill stands…'}
        {' '}Both share one daily ceiling and pace: the task's schedule under Task overrides on <Link to="/settings" className="text-primary underline">Settings</Link>; any session can still be titled from its own page.
      </p>
      {setEnabled.isError && (
        <p className="m-0 mt-2 font-sans text-sm text-tertiary" role="alert">
          {`The server did not ${setEnabled.variables ? 'start' : 'stop'} the backfill. `}
          <button type="button" className="underline" onClick={() => { if (!setEnabled.isPending) setEnabled.mutate(setEnabled.variables ?? stopped); }}>Try again</button>
        </p>
      )}
    </Panel>
  );
}
