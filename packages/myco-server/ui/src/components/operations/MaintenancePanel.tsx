import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Panel } from '../ui/panel';
import { fetchJson, postJson } from '../../lib/api';

type Check = 'optimize' | 'integrity';
type Support = { supported: true; label: string } | { supported: false; reason: string };
type Cadence =
  | { state: 'on'; intervalHours: number }
  | { state: 'off' }
  | { state: 'not_configured'; leaf: string }
  | { state: 'invalid'; leaf: string; reason: string };
type Measurement =
  | { name: string; state: 'measured'; value: number; unit: 'bytes' }
  | { name: string; state: 'unavailable'; reason: string };
interface Outcome {
  runId: string;
  trigger: 'schedule' | 'owner';
  state: 'running' | 'healthy' | 'findings' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  errorClass: string | null;
  findings: string[];
  findingsOmitted: number;
  measurements: Measurement[];
}
interface CheckStatus { check: Check; support: Support; cadence: Cadence; dueAt: number | null; running: boolean; latest: Outcome | null }

const TITLES: Record<Check, string> = { optimize: 'Optimize', integrity: 'Integrity check' };
const MEASUREMENT_WORDS: Record<string, string> = { size: 'Size', reclaimable: 'Reclaimable', size_limit: 'Size limit', daily_quota: 'Daily usage' };
const FAILURE_WORDS: Record<string, string> = {
  store_quota: 'the store reached its daily usage limit',
  store_size: 'the store is at its size limit',
  db: 'the store refused the check',
  constraint: 'the store refused the check',
  schema: 'the store is not at the schema this server expects',
};

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';
const dateLabel = (ms: number): string => new Date(ms).toLocaleString();
const bytesLabel = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

function cadenceWords(cadence: Cadence): string {
  if (cadence.state === 'on') return `Runs automatically every ${cadence.intervalHours} hours.`;
  if (cadence.state === 'off') return 'Automatic runs are off.';
  if (cadence.state === 'invalid') return `Automatic runs are not scheduled: the saved setting is invalid (${cadence.reason}).`;
  return 'Automatic runs are not set up. Turn them on and choose an interval under Settings · Maintenance.';
}

function outcomeWords(outcome: Outcome): string {
  const when = dateLabel(outcome.finishedAt ?? outcome.startedAt);
  const by = outcome.trigger === 'owner' ? 'run by hand' : 'scheduled';
  if (outcome.state === 'running') return `Running since ${dateLabel(outcome.startedAt)} (${by}).`;
  if (outcome.state === 'healthy') return `No problems found ${when} (${by}).`;
  if (outcome.state === 'findings') return `Problems found ${when} (${by}):`;
  return `Did not finish ${when} (${by}): ${FAILURE_WORDS[outcome.errorClass ?? ''] ?? `failed (${outcome.errorClass ?? 'unknown'})`}.`;
}

function CheckRow({ status }: { status: CheckStatus }) {
  const queries = useQueryClient();
  const run = useMutation({
    mutationFn: () => postJson<Outcome>(`/api/maintenance/${status.check}/run`),
    onSettled: () => { void queries.invalidateQueries({ queryKey: ['maintenance'] }); },
  });
  const latest = status.latest;
  return (
    <div className="flex flex-col gap-1 border-t border-outline-variant/20 pt-3 first:border-t-0 first:pt-0" data-testid={`maintenance-${status.check}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 font-sans text-sm font-medium text-on-surface">{TITLES[status.check]}</h3>
        {status.support.supported && (
          <button type="button" className={button} disabled={run.isPending || status.running} onClick={() => run.mutate()}>
            {run.isPending || status.running ? 'Running…' : 'Run now'}
          </button>
        )}
      </div>
      {!status.support.supported ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">Not available on this server: {status.support.reason}.</p>
      ) : (
        <>
          <p className="m-0 font-sans text-xs text-on-surface-variant">{status.support.label}. {cadenceWords(status.cadence)}</p>
          <p className="m-0 font-sans text-sm text-on-surface" data-testid={`maintenance-${status.check}-outcome`}>
            {latest === null ? 'Never run.' : outcomeWords(latest)}
          </p>
          {latest !== null && latest.findings.length > 0 && (
            <ul className="m-0 list-disc pl-5 font-mono text-xs text-on-surface">
              {latest.findings.map((f) => <li key={f}>{f}</li>)}
              {latest.findingsOmitted > 0 && <li>…and {latest.findingsOmitted} more not kept</li>}
            </ul>
          )}
          {latest !== null && latest.measurements.length > 0 && (
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 font-sans text-xs text-on-surface-variant">
              {latest.measurements.map((m) => (
                <div key={m.name} className="contents">
                  <dt>{MEASUREMENT_WORDS[m.name] ?? m.name}</dt>
                  <dd className="m-0">{m.state === 'measured' ? bytesLabel(m.value) : `Unavailable — ${m.reason}`}</dd>
                </div>
              ))}
            </dl>
          )}
          {run.isError && <p className="m-0 font-sans text-sm text-error" role="alert">{run.error.message}</p>}
        </>
      )}
    </div>
  );
}

/** The store's routine checks: what this server can run, what each last found, and a way to run one now. */
export function MaintenancePanel() {
  const status = useQuery({ queryKey: ['maintenance'], queryFn: ({ signal }) => fetchJson<{ checks: CheckStatus[] }>('/api/maintenance', signal) });
  return (
    <Panel title="Store maintenance" eyebrow="Server" data-testid="maintenance">
      {status.isError ? (
        <p className="m-0 font-sans text-sm text-error" role="alert">The server could not report its maintenance: {status.error.message}</p>
      ) : status.data === undefined ? (
        <p className="m-0 font-sans text-sm text-on-surface-variant">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {status.data.checks.map((c) => <CheckRow key={c.check} status={c} />)}
        </div>
      )}
    </Panel>
  );
}
