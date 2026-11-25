import { useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ActionLink, Button, Card, ErrorState, ShowMore, StatusChip, type Tone } from '../../../design';
import { permissionOf, useMe } from '../../../hooks/use-me';
import type { RunnerRow } from '../../../lib/api';
import { useFleet, useRemovedRunnerPages, useRunnerPages } from '../../../hooks/use-fleet';
import { runnerMachinePath } from '../../../routes/nav';
import { WorkTabs } from '../../work/WorkTabs';
import { AdminPage, AdminSection } from '../AdminFrame';
import { runnerDoing } from '../machine/words';
import { machineOfWorker, useMachines } from '../machines';
import { LegacyWorker } from './LegacyWorker';
import { QueueWarning } from './QueueWarning';
import { agoWords } from '@goondocks/myco-shared/time-words';

/** A runner's anchor on a Runners address leads to that runner's own place. */
const RUNNER_ANCHOR = /^#runner-(.+)$/;


/** Every machine entrusted with Myco's work, one row each leading to its machine's page; removed runners and legacy workers below. */
export function RunnersPage() {
  const anchored = RUNNER_ANCHOR.exec(useLocation().hash);
  if (anchored !== null) return <Navigate to={runnerMachinePath({ id: decodeURIComponent(anchored[1]!), machineId: null })} replace />;
  return <RunnersList />;
}

function RunnersList() {
  const runners = useFleet();
  const pages = useRunnerPages();
  const permission = permissionOf(useMe().data, 'runners');
  const machines = useMachines();
  const [setup, setSetup] = useState(false);
  return (
    <AdminPage name="runners" scope="server" title="Myco’s work" lede="Your machines run Myco’s work: learning from sessions, writing titles and keeping code maps current.">
      <WorkTabs projectId={null} section="runners" />
      {runners.isError && <><ErrorState error={runners.error} onRetry={() => void runners.refetch()} /><p className="t-small text-muted">Machine and queue information is unavailable. Last check failed {agoWords(runners.errorUpdatedAt)}.{runners.data !== undefined ? ` Last successful read ${agoWords(runners.data.observedAt)}; the rows below are stale.` : ' Last successful read unavailable.'}</p></>}
      {runners.isPending && <p className="t-body text-muted">Loading machines…</p>}
      {runners.data !== undefined && !runners.isError && <QueueWarning queue={runners.data.queue} />}
      <AdminSection id="runners" title="Registered runners" description="A runner is a machine you’ve chosen to run Myco’s work. Each opens its machine’s page, where it is turned on or off, who pays for it alone is chosen, and it is updated or removed.">
        {permission.allowed && <Button size="sm" onClick={() => setSetup(!setup)}>Add runner</Button>}
        {setup && <div className="rounded-card border border-line p-s4 t-small text-ink-2"><p>On the machine you want to use, run <code>myco runner register {window.location.origin}</code>. Open its device approval link, review the machine and approve it. If this machine has a legacy worker, let its assigned work finish and run <code>myco worker uninstall --server {window.location.origin}</code> on that machine. Then run <code>myco runner install</code> on that machine to start at login.</p><p className="mt-s2">Install a supported coding agent on that machine. Sign in there, or choose a stored key on its machine’s page after registration. Myco reports its sign-in; a model listing does not prove provider access.</p></div>}
        {pages.query.isError && <ErrorState error={pages.query.error} onRetry={() => void (pages.query.isFetchNextPageError ? pages.query.fetchNextPage() : pages.query.refetch())} />}
        {pages.query.isSuccess && !pages.query.hasNextPage && pages.runners.length === 0 && <p className="t-body text-muted">No runners are registered. Add a machine to run Myco’s work.</p>}
        {pages.runners.length > 0 && (
          <Card padding="flush"><ul aria-label="Registered runners" className="flex flex-col divide-y divide-line">{pages.runners.map((runner) => <RunnerItem key={runner.id} runner={runner} />)}</ul></Card>
        )}
        {(pages.query.hasNextPage || pages.query.isFetchingNextPage) && <ShowMore shown={pages.runners.length} total={pages.total} noun="runners" hasMore={pages.query.hasNextPage} pending={pages.query.isFetchingNextPage} onMore={() => void pages.query.fetchNextPage()} />}
      </AdminSection>
      <RemovedRunners />
      <AdminSection id="legacy-workers" title="Legacy workers" description="Machines that run Myco’s work the older way, signed in as their member instead of registered as runners. Register each as a runner, let its current work finish, then uninstall its legacy worker before installing the runner service.">
        {machines.error && <ErrorState error={machines.error} onRetry={machines.retry}><p>Machine names are unavailable.</p></ErrorState>}
        {runners.data?.legacyWorkers?.length === 0 && !runners.isError && <p className="t-small text-muted">{permission.allowed ? 'No legacy workers are remembered.' : 'None of your machines run a legacy worker.'}</p>}
        <div className="flex flex-col gap-s2">{runners.data?.legacyWorkers?.map(worker => <LegacyWorker key={worker.credentialId} worker={worker} name={machineOfWorker(machines.machines, worker)?.name ?? worker.machineId ?? 'A machine'} />)}</div>
      </AdminSection>
    </AdminPage>
  );
}

/** Removed runners load on request, page by page: the active list and its totals never carry them. Each leads to its place. */
function RemovedRunners() {
  const [open, setOpen] = useState(false);
  const removed = useRemovedRunnerPages(open);
  return (
    <AdminSection id="removed-runners" title="Removed runners" description="Runners that can no longer run work.">
      <details onToggle={event => setOpen(event.currentTarget.open)} className="t-small text-ink-2">
        <summary className="min-h-tap content-center cursor-pointer">Show removed runners</summary>
        {removed.query.isError && <ErrorState error={removed.query.error} onRetry={() => void (removed.query.isFetchNextPageError ? removed.query.fetchNextPage() : removed.query.refetch())} />}
        {removed.query.isSuccess && removed.runners.length === 0 && <p className="text-muted">No runners have been removed.</p>}
        <ul className="mt-s2 flex flex-col gap-s1">{removed.runners.map(runner => (
          <li key={runner.id} className="flex flex-wrap items-center gap-x-s3">{runner.name}{runner.removedAt === null ? '' : ` — removed ${agoWords(runner.removedAt)}`}<ActionLink to={runnerMachinePath(runner)}>Its machine</ActionLink></li>
        ))}</ul>
        {(removed.query.hasNextPage || removed.query.isFetchingNextPage) && <ShowMore shown={removed.runners.length} noun="removed runners" hasMore={removed.query.hasNextPage} pending={removed.query.isFetchingNextPage} onMore={() => void removed.query.fetchNextPage()} />}
      </details>
    </AdminSection>
  );
}

const DISPLAY_TONE: Readonly<Record<string, Tone>> = { Online: 'ok', Busy: 'ok', 'Not ready': 'warn' };

/** One runner: its name, how it stands, what it is doing or last did, and its machine's page. */
function RunnerItem({ runner }: { runner: RunnerRow }) {
  return (
    <li id={`runner-${runner.id}`} className="flex scroll-mt-s6 flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-runner={runner.id}>
      <div className="flex min-w-0 flex-col gap-s1">
        <span className="t-body font-medium text-ink break-words">{runner.name}</span>
        <span className="t-small text-muted">{runnerDoing(runner)}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-s2">
        <StatusChip tone={DISPLAY_TONE[runner.display] ?? 'neutral'}>{runner.display}</StatusChip>
        <ActionLink to={runnerMachinePath(runner)}>Its machine</ActionLink>
      </div>
    </li>
  );
}
