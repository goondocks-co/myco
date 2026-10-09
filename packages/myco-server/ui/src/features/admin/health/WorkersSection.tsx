import { LegacyWorker } from '../runners/LegacyWorker';
import { Card, CommandBlock, ErrorState, HealthDot, ReadState } from '../../../design';
import type { useStatus } from '../../../hooks/use-status';
import type { WorkerStatus } from '../../../lib/api';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { machineOfWorker, useMachines, type Machine } from '../machines';
import { agentsWords, ATTACH_WORDS, fleetLine, lastClaimWords, workerLine } from '../workers';

export interface WorkersSectionProps {
  status: ReturnType<typeof useStatus>;
  now: number;
  projectName: (projectId: string) => string | null;
}

/**
 * Workers: the machines that run Myco's work, each named by its machine, with
 * what it last reported and why its last check for work took nothing. A server
 * that could not be asked says so; it is never read as having no workers.
 */
export function WorkersSection({ status, now, projectName }: WorkersSectionProps) {
  const machines = useMachines();
  const workers = status.data?.workers;
  return (
    <AdminSection id={HEALTH_ANCHORS.workers} title="Workers" description="The machines that run Myco’s work: learning, titling and code map updates.">
      <ReadState data={workers} pending={status.isPending} error={status.error} onRetry={() => void status.refetch()} label="workers">
        {(value) => <>
          {machines.error && <ErrorState error={machines.error} onRetry={machines.retry}><p>Couldn’t read machine names.</p></ErrorState>}
          <Fleet workers={value} machines={machines.machines} now={now} projectName={projectName} />
        </>}
      </ReadState>
    </AdminSection>
  );
}

function Fleet({ workers, machines, now, projectName }: { workers: WorkerStatus; machines: readonly Machine[]; now: number; projectName: WorkersSectionProps['projectName'] }) {
  if (!workers.available || workers.fleet === null || workers.runsQueued === null) {
    return (
      <Card className="flex items-start gap-s2" data-health-fleet="unknown">
        <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone="warn" label="Unknown" /></span>
        <p className="t-body text-ink-2">Whether machines are running Myco’s work is unknown: this server could not read its own database.</p>
      </Card>
    );
  }
  const headline = fleetLine(workers, now);
  return (
    <div className="flex flex-col gap-s3" data-health-fleet="">
      <p className="flex items-start gap-s2 t-body text-ink">
        <span className="flex h-lh shrink-0 items-center"><HealthDot tone={headline.tone} label={headline.attached > 0 ? 'Running' : 'None running'} /></span>
        <span>{headline.line}</span>
      </p>
      {headline.attached === 0 && (
        <CommandBlock caption={`${ATTACH_WORDS.before} this command ${ATTACH_WORDS.after}`} command={ATTACH_WORDS.command} />
      )}
      {workers.fleet.length > 0 && (
        <>
        {([{ label: 'Registered runners', rows: workers.fleet.filter((w) => w.runner != null) }, { label: 'Legacy workers', rows: workers.fleet.filter((w) => w.runner == null) }]).filter((group) => group.rows.length > 0).map((group) => <RowCard key={group.label} label={group.label}>
          {group.rows.map((worker) => {
            const machine = machineOfWorker(machines, worker)?.name ?? 'A machine';
            if (worker.runner == null) return <LegacyWorker key={worker.credentialId} worker={worker} name={machine} />;
            const state = workerLine(worker, now, { machine, project: projectName });
            const claim = lastClaimWords(worker);
            return (
              <div key={worker.credentialId} className="flex flex-col gap-s1 px-s4 py-s3" data-health-worker="">
                <p className="flex items-start gap-s2 t-body text-ink">
                  <span className="flex h-lh shrink-0 items-center"><HealthDot tone={state.tone} label={state.tone === 'ok' ? 'Working' : state.tone === 'bad' ? 'Needs attention' : 'Quiet'} /></span>
                  <span className="min-w-0">{state.line}</span>
                </p>
                <p className="pl-s4 t-small text-muted">{agentsWords(worker)}</p>
                {claim !== null && <p className="pl-s4 t-small text-muted">{claim} That is what this machine’s last check found, not what every machine can run.</p>}
              </div>
            );
          })}
        </RowCard>)}
        </>
      )}
    </div>
  );
}
