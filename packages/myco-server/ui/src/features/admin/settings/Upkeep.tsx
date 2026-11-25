import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Disclosure, ErrorState, LoadingState, ReadState, errorWords } from '../../../design';
import { useWork } from '../../../hooks/use-work';
import { ApiError, postJson } from '../../../lib/api';
import { useMaintenance } from '../../../hooks/use-maintenance';
import { formatBytes, formatCount } from '../../../lib/format';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { useEmbeddingSwitch, usePassedOver } from '../../../hooks/use-settings';
import { UpkeepLine } from '../../today/Summary';
import type { CheckStatus, MaintenanceOutcome, TickReport } from '../health/wire';
import { CHECK_TITLES, findingWords, groupedFindings, measurementWords, supportWords, checkCadenceWords, measurementName, outcomeWords, reportWords } from '../health/words';
import { EmbeddingSwitchPanel, PassedOverSources } from './EmbeddingSwitch';

const HOUR = 3_600_000;

/**
 * Upkeep, under Settings › Advanced: what this server does on its own to stay well, each with a way to run it now.
 * The search index's upkeep over the last day and the sources search by meaning passes over, housekeeping, and the
 * store's routine checks.
 */
export function Upkeep() {
  return (
    <>
      <SearchUpkeep />
      <Housekeeping />
      <Maintenance />
    </>
  );
}

/** The search index's upkeep over the last day across every project, in the one line Today shows, and the sources search by meaning passes over. */
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
      {upkeep !== undefined && work.error !== null && <StaleRead onRetry={() => void work.refetch()} />}
      <ModelSwitch />
      <PassedOver />
    </Card>
  );
}

/** A refresh that failed while an earlier answer is shown: said, with a way to read it again. */
function StaleRead({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="status" className="flex flex-wrap items-center gap-s2 t-small text-warn">
      <span>Couldn’t refresh this just now; it shows what was read before.</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
    </p>
  );
}

/** A switch of the search model under way, with how far rebuilding search has come; nothing while there is none. */
function ModelSwitch() {
  const sw = useEmbeddingSwitch();
  return (
    <ReadState data={sw.data} pending={sw.isPending} error={sw.error} onRetry={() => void sw.refetch()} label="a switch of the search model">
      {(value) => value === null ? null : <EmbeddingSwitchPanel sw={value} now={Date.now()} />}
    </ReadState>
  );
}

/** The sources search by meaning passes over, each named with why; nothing while there is none. */
function PassedOver() {
  const passed = usePassedOver();
  return (
    <ReadState data={passed.data} pending={passed.isPending} error={passed.error} onRetry={() => void passed.refetch()} label="sources left out of search">
      {(value) => value.state === 'building' ? <p className="t-small text-muted">Measuring passed-over sources…</p> : value.count === 0 ? null : <div data-passed-over="">
        <PassedOverSources list={value} lede={`Search by meaning leaves out ${formatCount(value.count, 'source')}. Search by words still finds ${value.count === 1 ? 'it' : 'them'}.`} />
      </div>}
    </ReadState>
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
  const status = useMaintenance();
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
      {status.data !== undefined && status.error !== null && <StaleRead onRetry={() => void status.refetch()} />}
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
        <p className="t-small text-muted">{supportWords(status.support.reasonCode)}</p>
      ) : (
        <>
          <p className="t-small text-muted">{status.support.label}. {checkCadenceWords(status.cadence)}</p>
          <p className="t-small text-ink-2" data-testid={`maintenance-${status.check}-outcome`}>
            {latest === null ? (status.running ? 'Running…' : 'Never run.') : outcomeWords(latest, status.running)}
          </p>
          {latest !== null && latest.findings.length > 0 && (
            <div className="flex flex-col gap-s1">
              <p className="t-small text-ink-2">{findingWords(latest.findingCodes?.[0])}</p>
              <Disclosure summary="Findings">
                <ul className="flex list-disc flex-col gap-s1 pl-s5 t-mono text-ink-2">
                  {groupedFindings(latest.findings).map(({ text, count }) => <li key={text}>{text}{count > 1 ? ` (${count} findings)` : ''}</li>)}
                  {latest.findingsOmitted > 0 && <li>…and {latest.findingsOmitted} more not kept</li>}
                </ul>
              </Disclosure>
            </div>
          )}
          {latest !== null && latest.measurements.length > 0 && (
            <dl className="flex flex-col gap-s1 t-small">
              {latest.measurements.map((m) => (
                <div key={m.name} className="flex flex-wrap gap-x-s3">
                  <dt className="text-muted">{measurementName(m.name)}</dt>
                  <dd className="text-ink-2">{m.state === 'measured' ? `${formatBytes(m.value)}, measured ${agoWords(latest.finishedAt ?? latest.startedAt)}` : measurementWords(m.reasonCode)}</dd>
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
