import { Navigate, useParams } from 'react-router-dom';
import { ActionLink, Breadcrumbs, Card, EmptyState, ErrorState, HealthDot, LoadingState } from '../../../design';
import { useMe } from '../../../hooks/use-me';
import { machinePath, PEOPLE_SETTINGS_PATH, SETTINGS_PATH } from '../../../routes/nav';
import { AdminPage, useAnchorScroll } from '../AdminFrame';
import type { Machine } from '../machines';
import { useMemberNames } from '../members';
import { CapturePart } from './CapturePart';
import { CurrentPart } from './CurrentPart';
import { useMachineClaim, useRunnerOn } from './reads';
import { MachineMenu, RemovePart } from './RemovePart';
import { machineVerdict, ownerWords } from './words';
import { WorkPart } from './WorkPart';

/** `/settings/people/machines/:machineId`: one machine, from its sign-ins and the runner registered on it. */
export function MachinePage() {
  const machineId = useParams().machineId ?? '';
  const claim = useMachineClaim(machineId);
  const runner = useRunnerOn({ machineId });
  return <MachineView key={machineId} claim={claim} runner={runner} />;
}

/** `/settings/people/runners/:runnerId`: a runner's page; one that reported a machine id leads to that machine's page. */
export function RunnerMachinePage() {
  const runnerId = useParams().runnerId ?? '';
  const runner = useRunnerOn({ runnerId });
  if (runner.runner?.machineId != null) return <Navigate to={machinePath(runner.runner.machineId)} replace />;
  return <MachineView key={runnerId} claim={null} runner={runner} />;
}

interface ClaimRead { data: Machine | null | undefined; isPending: boolean; error: unknown; refetch: () => unknown }

/**
 * One machine's page: its verdict in one word and one sentence, whose it is and since when, and what it reported of
 * itself; then whether it does Myco's work, what it captures, how it stays current, and removing it. Only what the
 * server recorded is said; a fact it lacks is left out, a read that failed says so.
 */
function MachineView({ claim: claimRead, runner: runnerRead }: { claim: ClaimRead | null; runner: ReturnType<typeof useRunnerOn> }) {
  const viewerId = useMe().data?.member?.id ?? null;
  const nameOf = useMemberNames();
  const claim = claimRead?.data ?? null;
  const runner = runnerRead.runner;
  const claimPending = claimRead !== null && claimRead.isPending && claimRead.error == null;
  const ready = !claimPending && (runnerRead.settled || runner !== null);
  useAnchorScroll(ready);
  const crumbs = <Breadcrumbs items={[{ label: 'Settings', to: SETTINGS_PATH }, { label: 'People and machines', to: PEOPLE_SETTINGS_PATH }]} />;

  if (!ready && claimRead?.error == null && runnerRead.error == null) {
    return <AdminPage name="machine" title="A machine">{crumbs}<LoadingState label="Reading this machine" count={3} /></AdminPage>;
  }
  if (claim === null && runner === null && (claimRead === null || claimRead.error == null) && runnerRead.settled && runnerRead.error == null) {
    return (
      <AdminPage name="machine" title="No machine here">
        {crumbs}
        <Card><EmptyState title="No machine you can see has this address." className="py-0" action={<ActionLink to={PEOPLE_SETTINGS_PATH}>See every machine</ActionLink>} /></Card>
      </AdminPage>
    );
  }

  const name = claim?.name ?? runner?.name ?? 'A machine';
  const verdict = machineVerdict(claim, runner, Date.now(), nameOf);
  const owner = claim !== null
    ? ownerWords({ memberId: claim.memberId, viewerId, name: nameOf(claim.memberId) }, { at: claim.firstSeenAt, registered: false })
    : runner !== null ? ownerWords({ memberId: runner.createdBy, viewerId, name: nameOf(runner.createdBy) }, { at: runner.createdAt, registered: true }) : null;
  const reported = runner === null ? [] : [runner.os, runner.arch, runner.version === null ? null : `version ${runner.version}`].filter((fact): fact is string => fact !== null);
  const working = runner !== null && runner.state !== 'removed';
  const work = <WorkPart runner={runner} storedUsable={runnerRead.storedUsable} read={runnerRead} />;
  const capture = claimRead !== null && claimRead.error != null
    ? <ErrorState error={claimRead.error} onRetry={() => void claimRead.refetch()}><p>What it captures couldn’t be read.</p></ErrorState>
    : <CapturePart claim={claim} viewerId={viewerId} />;

  return (
    <AdminPage name="machine" title={name} actions={<MachineMenu claim={claim} runner={runner} />}>
      {crumbs}
      <Card className="flex items-start gap-s3" data-machine-verdict={verdict.label}>
        <span className="flex h-lh shrink-0 items-center t-h3"><HealthDot tone={verdict.tone} label={verdict.label} /></span>
        <div className="flex min-w-0 flex-col gap-s1">
          <p className="t-h3 text-ink">{verdict.label}</p>
          <p className="t-small text-ink-2">{verdict.line}{owner === null ? '' : ` ${owner}`}</p>
          {runner !== null && claim !== null && runner.name !== claim.name && <p className="t-small text-muted">It runs Myco’s work as {runner.name}.</p>}
          {runnerRead.others > 0 && <p className="t-small text-muted">{runnerRead.others === 1 ? 'One more runner registration names' : `${runnerRead.others} more runner registrations name`} this machine; this page shows the one seen most recently.</p>}
          {reported.length > 0 && <p className="t-meta text-faint" data-machine-reported="">It reported {reported.join(', ')}.</p>}
        </div>
      </Card>
      {working ? <>{work}{capture}</> : <>{capture}{work}</>}
      <CurrentPart claim={claim} runner={runner} viewerId={viewerId} />
      <RemovePart claim={claim} runner={runner} />
    </AdminPage>
  );
}
