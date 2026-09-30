import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, buttonVariants, Card, ErrorState, LoadingState, errorWords } from '../../../design';
import { useWork } from '../../../hooks/use-work';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { formatBytes } from '../../../lib/format';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { UpkeepLine } from '../../today/Summary';
import { AdminSection } from '../AdminFrame';
import type { CheckStatus, MaintenanceAnswer, MaintenanceOutcome, TickReport } from './wire';
import { CHECK_TITLES, checkCadenceWords, measurementName, outcomeWords, reportWords } from './words';

const HOUR = 3_600_000;
/** How often the checks are read again while one runs, so its outcome appears without a reload. */
const RUNNING_REFRESH_MS = 5_000;

/**
 * Upkeep: what this server does on its own to stay well. The search index's
 * upkeep over the last day, housekeeping run on demand, the store's routine
 * checks, and the diagnostics file an admin attaches to an issue.
 */
export function UpkeepSection() {
  return (
    <AdminSection id={HEALTH_ANCHORS.upkeep} title="Upkeep" description="What this server does on its own to stay well, and a way to run it now.">
      <SearchUpkeep />
      <Housekeeping />
      <Maintenance />
      <Card className="flex flex-col gap-s2" data-testid="diagnostics">
        <h3 className="t-h3 text-ink">Diagnostics</h3>
        <p className="max-w-measure t-small text-muted">
          One file describing this server: its schema, what it is set up to run, the machines running its work, the tasks waiting, and what each project last sent. Attach it to an issue.
          It carries no keys, no captured content and no error messages; every failure is named rather than quoted. On your own machine, <code className="t-mono">myco member export</code> writes the matching half.
        </p>
        <a className={cn(buttonVariants({ size: 'sm' }), 'w-fit')} href="/api/diagnostics" download data-testid="download-diagnostics">Download diagnostics</a>
      </Card>
    </AdminSection>
  );
}

/** The search index's upkeep over the last day across every project, in the one line Today shows. */
function SearchUpkeep() {
  const [window] = useState(() => {
    const now = Date.now();
    return { since: now - 24 * HOUR, until: now + 24 * HOUR, now };
  });
  const work = useWork({ projectId: null, since: window.since, until: window.until, live: true });
  const upkeep = work.data?.upkeep;
  return (
    <Card className="flex flex-col gap-s2" data-health-search="">
      <h3 className="t-h3 text-ink">Search</h3>
      {work.isPending ? <LoadingState label="Reading the search index’s upkeep" count={1} />
        : upkeep === undefined ? <ErrorState error={work.error} onRetry={() => void work.refetch()} />
        : upkeep.lastSuccessAt === null && upkeep.unrecovered === null
          ? <p className="t-small text-muted">The search index has not been updated in the last day.</p>
          : <UpkeepLine upkeep={upkeep} now={Date.now()} statusHref={null} />}
    </Card>
  );
}

/** Run the server's housekeeping now, the same pass its clock runs, and say what it did. */
function Housekeeping() {
  const queries = useQueryClient();
  const wake = useMutation({
    mutationFn: () => postJson<TickReport>('/api/wake'),
    onSuccess: () => { void queries.invalidateQueries({ queryKey: ['runs'] }); void queries.invalidateQueries({ queryKey: ['status'] }); },
  });
  return (
    <Card className="flex flex-col gap-s3" data-health-housekeeping="">
      <div className="flex flex-wrap items-start justify-between gap-s3">
        <div className="flex min-w-0 flex-col gap-s1">
          <h3 className="t-h3 text-ink">Housekeeping</h3>
          <p className="max-w-measure t-small text-muted" role={wake.isError ? 'alert' : undefined}>
            {wake.data !== undefined
              ? reportWords(wake.data)
              : wake.isError
                ? 'The server could not run its housekeeping right now.'
                : 'Old run records are removed and runs whose machine stopped answering are closed on the server\'s own clock. Run it now to see the state it is in.'}
          </p>
        </div>
        <Button size="sm" pending={wake.isPending} onClick={() => wake.mutate()}>Run housekeeping now</Button>
      </div>
    </Card>
  );
}

/** The store's routine checks: what this server can run, what each last found, and a way to run one now. */
function Maintenance() {
  const status = useQuery({
    queryKey: ['maintenance'],
    queryFn: ({ signal }) => fetchJson<MaintenanceAnswer>('/api/maintenance', signal),
    refetchInterval: (query) => (query.state.data?.checks.some((c) => c.running) ? RUNNING_REFRESH_MS : false),
  });
  return (
    <Card className="flex flex-col gap-s3" data-testid="maintenance">
      <h3 className="t-h3 text-ink">Store checks</h3>
      {status.isPending ? <LoadingState label="Reading the store checks" count={2} />
        : status.data === undefined ? <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        : status.data.checks.length === 0 ? <p className="t-small text-muted">This server runs no routine checks on its store.</p>
        : (
          <div className="flex flex-col divide-y divide-line">
            {status.data.checks.map((check) => <CheckRow key={check.check} status={check} />)}
          </div>
        )}
    </Card>
  );
}

/** Why a check was not run, from the server's refusal code, in words. */
const MAINTENANCE_REFUSALS: Readonly<Record<string, string>> = {
  unsupported: 'This server can’t run that check.',
  not_configured: 'That check has no schedule set.',
  already_running: 'That check is already running.',
  not_due: 'That check is not due yet.',
};

function maintenanceRefusal(error: unknown): string {
  const refusal = error instanceof ApiError ? Reflect.get(Object(error.body), 'refusal') : undefined;
  return (typeof refusal === 'string' ? MAINTENANCE_REFUSALS[refusal] : undefined) ?? `${errorWords(error).title}.`;
}

function CheckRow({ status }: { status: CheckStatus }) {
  const queries = useQueryClient();
  const run = useMutation({
    mutationFn: () => postJson<MaintenanceOutcome>(`/api/maintenance/${status.check}/run`),
    onSettled: () => { void queries.invalidateQueries({ queryKey: ['maintenance'] }); },
  });
  const latest = status.latest;
  const busy = run.isPending || status.running;
  return (
    <div className="flex flex-col gap-s2 py-s3 first:pt-0 last:pb-0" data-testid={`maintenance-${status.check}`}>
      <div className="flex items-center justify-between gap-s3">
        <h4 className="t-body font-medium text-ink">{CHECK_TITLES[status.check]}</h4>
        {status.support.supported && (
          <Button size="sm" disabled={busy} onClick={() => run.mutate()}>{busy ? 'Running…' : 'Run now'}</Button>
        )}
      </div>
      {!status.support.supported ? (
        <p className="t-small text-muted">Not available on this server.</p>
      ) : (
        <>
          <p className="t-small text-muted">{status.support.label}. {checkCadenceWords(status.cadence)}</p>
          <p className="t-small text-ink-2" data-testid={`maintenance-${status.check}-outcome`}>
            {latest === null ? (status.running ? 'Running…' : 'Never run.') : outcomeWords(latest, status.running)}
          </p>
          {latest !== null && latest.findings.length > 0 && (
            <ul className="flex list-disc flex-col gap-s1 pl-s5 t-mono text-ink-2">
              {latest.findings.map((finding) => <li key={finding}>{finding}</li>)}
              {latest.findingsOmitted > 0 && <li>…and {latest.findingsOmitted} more not kept</li>}
            </ul>
          )}
          {latest !== null && latest.measurements.length > 0 && (
            <dl className="flex flex-col gap-s1 t-small">
              {latest.measurements.map((m) => (
                <div key={m.name} className="flex flex-wrap gap-x-s3">
                  <dt className="text-muted">{measurementName(m.name)}</dt>
                  <dd className="text-ink-2">{m.state === 'measured' ? formatBytes(m.value) : 'Unavailable'}</dd>
                </div>
              ))}
            </dl>
          )}
          {run.isError && <p role="alert" className="t-small text-bad">{maintenanceRefusal(run.error)}</p>}
        </>
      )}
    </div>
  );
}
