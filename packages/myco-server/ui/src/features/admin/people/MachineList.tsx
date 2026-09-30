import { useState } from 'react';
import { REJOIN_FOR_ADMIN } from '@goondocks/myco-shared/member-protocol';
import { Card, ConfirmDialog, EmptyState, ErrorState, HealthDot, LoadingState, MoreMenu, ShowMore, type HealthTone, type MoreMenuItem } from '../../../design';
import { refusalText, useAccessActions } from '../../../hooks/use-access';
import { useMe } from '../../../hooks/use-me';
import { useProjects } from '../../../hooks/use-projects';
import { useWorkerFleet } from '../../../hooks/use-status';
import type { WorkerRow, WorkerStatus } from '../../../lib/api';
import { machineOfWorker, type Machine } from '../machines';
import { agentsWords, lastClaimWords, workerState } from '../workers';
import { ActivityDialog, type ActivityTarget } from './ActivityDialog';
import { MachineSettingsDialog } from './MachineSettingsDialog';
import { shortDate, standingWords } from './words';

/** What the list says where it cannot tell whether a machine runs Myco's work. */
export const FLEET_WORDS = {
  unavailable: 'Whether it runs Myco’s work is unknown: the server could not be asked.',
  absent: 'No record of it running Myco’s work lately.',
} as const;

/** A stop that did not finish, in words: how many sign-ins stopped of how many, that the machine can still write, and why. */
export function stopWords(stopped: number, total: number, why: string): string {
  return `Stopped ${stopped} of ${total} ${total === 1 ? 'sign-in' : 'sign-ins'}; this machine can still write. ${why} Try again.`;
}

const STANDING_TONE: Record<Machine['standing'], HealthTone> = { allowed: 'ok', stopped: 'faint', replayed: 'bad', expired: 'faint' };
const STANDING_LABEL: Record<Machine['standing'], string> = { allowed: 'Allowed to write', stopped: 'Stopped', replayed: 'Stopped', expired: 'Expired' };

export interface MachineListProps {
  machines: readonly Machine[];
  /** The signed-in member: only their own machines offer their settings. */
  viewerId: string | null;
  /** A member's name, or null when the page cannot name them. */
  nameOf: (memberId: string | null | undefined) => string | null;
  /** Names each machine's member; left out where every machine is the viewer's. */
  showOwner: boolean;
  /** The paging of the credentials the machines were built from. */
  paging: { isPending: boolean; error: unknown; hasMore: boolean; isFetchingMore: boolean; more: () => void; retry: () => void };
  /** What the list says when there is no machine. */
  empty: string;
}

/**
 * Machines, one row each: its name, whose it is and where it stands, what it
 * last reported when it runs Myco's work, and a ⋯ menu with its settings (on
 * the viewer's own), what it wrote, and Stop behind a confirm.
 */
export function MachineList({ machines, viewerId, nameOf, showOwner, paging, empty }: MachineListProps) {
  const answered = useWorkerFleet();
  // A server that could not read its own record answers an empty fleet, which says nothing: it is unknown, not empty.
  const fleet = answered?.available === true ? answered : undefined;
  const projects = useProjects();
  const me = useMe();
  // The viewer's own machine names them by the login they signed in with where their label is only their id.
  const viewerName = me.data?.login !== undefined && me.data.login !== '' ? me.data.login : 'You';
  const stop = useAccessActions().revokeCredentials;
  const [settingsFor, setSettingsFor] = useState<{ id: string; name: string } | null>(null);
  const [activityFor, setActivityFor] = useState<ActivityTarget | null>(null);
  const [stopping, setStopping] = useState<Machine | null>(null);
  /** The sign-ins still to stop: the machine's live ones, then, after a partial failure, only those that did not stop. */
  const [toStop, setToStop] = useState<readonly string[]>([]);
  const [stopError, setStopError] = useState<string | null>(null);
  const projectName = (id: string) => projects.data?.projects.find((p) => p.projectId === id)?.name ?? null;

  if (paging.isPending) return <LoadingState label="Reading the machines" count={2} />;
  if (paging.error != null && machines.length === 0) return <ErrorState error={paging.error} onRetry={paging.retry} />;
  if (machines.length === 0) return <EmptyState title={empty} />;

  return (
    <div className="flex flex-col">
      <Card padding="flush">
        <ul aria-label="Machines" className="flex flex-col divide-y divide-line">
          {machines.map((machine) => (
            <MachineItem
              key={machine.key}
              machine={machine}
              owner={showOwner ? nameOf(machine.memberId) ?? (machine.memberId === viewerId ? viewerName : 'A teammate') : null}
              stoppedBy={nameOf(machine.stoppedBy)}
              fleet={fleet}
              projectName={projectName}
              actions={[
                ...(machine.memberId === viewerId && machine.machineId !== null
                  ? [{ label: 'Its settings', onSelect: () => setSettingsFor({ id: machine.machineId!, name: machine.name }) }]
                  : []),
                { label: 'What it wrote', onSelect: () => setActivityFor({ name: machine.name, credentialIds: machine.credentials.map((c) => c.id), bytesWritten: machine.credentials.reduce((n, c) => n + c.bytesWritten, 0) }) },
                ...(machine.live.length > 0 ? [{ label: 'Stop', tone: 'danger' as const, onSelect: () => { setStopError(null); stop.reset(); setToStop(machine.live.map((c) => c.id)); setStopping(machine); } }] : []),
              ]}
            />
          ))}
        </ul>
      </Card>
      {(paging.hasMore || paging.isFetchingMore) && (
        <ShowMore shown={machines.length} noun="machines" hasMore={paging.hasMore} pending={paging.isFetchingMore} onMore={paging.more} />
      )}
      <MachineSettingsDialog machine={settingsFor} onClose={() => setSettingsFor(null)} />
      <ActivityDialog target={activityFor} onClose={() => setActivityFor(null)} />
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => { if (!open) setStopping(null); }}
        title={`Stop ${stopping?.name ?? 'this machine'}?`}
        description={`It stops writing at once. ${REJOIN_FOR_ADMIN} What it already wrote stays.`}
        confirmLabel="Stop"
        pending={stop.isPending}
        error={stopError}
        onConfirm={() => {
          if (stopping === null) return;
          stop.mutate(toStop, {
            onSuccess: (outcome) => {
              if (outcome.failed.length === 0) { setStopping(null); return; }
              const total = outcome.stopped.length + outcome.failed.length;
              setToStop(outcome.failed.map((f) => f.id));
              setStopError(stopWords(outcome.stopped.length, total, refusalText(outcome.failed[0]!.error)));
            },
            onError: (err) => setStopError(refusalText(err)),
          });
        }}
      />
    </div>
  );
}

interface MachineItemProps {
  machine: Machine;
  owner: string | null;
  stoppedBy: string | null;
  fleet: WorkerStatus | undefined;
  projectName: (projectId: string) => string | null;
  actions: MoreMenuItem[];
}

function MachineItem({ machine, owner, stoppedBy, fleet, projectName, actions }: MachineItemProps) {
  const now = Date.now();
  const workers: WorkerRow[] = fleet === undefined ? [] : fleet.fleet.filter((worker) => machineOfWorker([machine], worker) !== undefined);
  const lines = workers.map((worker) => ({ worker, ...workerState(worker, now, projectName) }));
  const tone = lines[0]?.tone ?? STANDING_TONE[machine.standing];
  const meta = [owner, standingWords(machine, stoppedBy), `first signed in ${shortDate(machine.firstSeenAt, now)}`].filter((part) => part !== null).join(' · ');
  return (
    <li className="flex items-start gap-s3 px-s4 py-s3" data-machine={machine.named ? 'named' : 'unnamed'}>
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={tone} label={STANDING_LABEL[machine.standing]} /></span>
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <span className="t-body font-medium text-ink">{machine.name}</span>
        <span className="t-small text-muted">{meta}</span>
        {lines.map(({ worker, line }) => (
          <div key={worker.credentialId} className="flex flex-col" data-worker-line="">
            <span className="t-small text-ink-2">{line}</span>
            <span className="t-small text-muted">{agentsWords(worker)}</span>
            {lastClaimWords(worker) !== null && <span className="t-small text-muted">{lastClaimWords(worker)}</span>}
          </div>
        ))}
        {lines.length === 0 && machine.standing === 'allowed' && (
          <span className="t-small text-muted" data-worker-line="">{fleet === undefined ? FLEET_WORDS.unavailable : FLEET_WORDS.absent}</span>
        )}
      </div>
      <MoreMenu label={`More for ${machine.name}`} items={actions} />
    </li>
  );
}
