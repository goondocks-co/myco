import { Navigate, useLocation, useParams } from 'react-router-dom';
import { ActionLink, Breadcrumbs, Card, EmptyState, ErrorState, HealthDot, LoadingState } from '../../../design';
import { useIsAdmin, useMe } from '../../../hooks/use-me';
import { machinePath, PEOPLE_SETTINGS_PATH, SETTINGS_PATH } from '../../../routes/nav';
import { AdminPage, useAnchorScroll } from '../AdminFrame';
import type { Machine } from '../machines';
import { useMemberNames } from '../members';
import { CapturePart } from './CapturePart';
import { CurrentPart } from './CurrentPart';
import { useMachineClaim, useRunnersOn } from './reads';
import { MachineMenu, StopCapturePart } from './RemovePart';
import { machineVerdict, ownerWords } from './words';
import { WorkPart } from './WorkPart';

/** `/settings/people/machines/:machineId`: one machine, from its sign-ins and every runner registration bound to it. */
export function MachinePage() {
  const machineId = useParams().machineId ?? '';
  const claim = useMachineClaim(machineId);
  const runners = useRunnersOn({ machineId });
  return <MachineView key={machineId} claim={claim} runners={runners} />;
}

/**
 * `/settings/people/runners/:runnerId`: one runner registration. One bound to a machine leads to that machine's page at
 * its own card; one with no machine bound has its page here.
 */
export function RunnerMachinePage() {
  const runnerId = useParams().runnerId ?? '';
  const { hash } = useLocation();
  const runners = useRunnersOn({ runnerId });
  const runner = runners.runners[0];
  if (runner?.machineId != null) return <Navigate to={`${machinePath(runner.machineId)}${hash === '' ? `#runner-${encodeURIComponent(runner.id)}` : hash}`} replace />;
  return <MachineView key={runnerId} claim={null} runners={runners} />;
}

interface ClaimRead { data: Machine | null | undefined; isPending: boolean; error: unknown; refetch: () => unknown }

/**
 * One machine's page: its verdict in one word and one sentence, whose it is and since when, and what it reported of
 * itself; then whether it does Myco's work, one card per runner registration on it, what it captures, how it stays
 * current, and stopping it capturing. Only what the server recorded is said; a read that failed says so.
 */
function MachineView({ claim: claimRead, runners: runnersRead }: { claim: ClaimRead | null; runners: ReturnType<typeof useRunnersOn> }) {
  const viewerId = useMe().data?.member?.id ?? null;
  const admin = useIsAdmin();
  const nameOf = useMemberNames();
  const claim = claimRead?.data ?? null;
  const runners = runnersRead.runners;
  const live = runners.filter((runner) => runner.state !== 'removed');
  const claimPending = claimRead !== null && claimRead.isPending && claimRead.error == null;
  const ready = !claimPending && runnersRead.settled;
  useAnchorScroll(ready);
  const crumbs = <Breadcrumbs items={admin ? [{ label: 'Settings', to: SETTINGS_PATH }, { label: 'People and machines', to: PEOPLE_SETTINGS_PATH }] : [{ label: 'People and machines', to: PEOPLE_SETTINGS_PATH }]} />;

  if (!ready && claimRead?.error == null && runnersRead.error == null) {
    return <AdminPage name="machine" title="A machine">{crumbs}<LoadingState label="Reading this machine" count={3} /></AdminPage>;
  }
  if (claim === null && runners.length === 0 && runnersRead.legacy.length === 0 && (claimRead === null || claimRead.error == null) && runnersRead.settled && runnersRead.error == null) {
    return (
      <AdminPage name="machine" title="No machine here">
        {crumbs}
        <Card><EmptyState title="No machine you can see has this address." className="py-0" action={<ActionLink to={PEOPLE_SETTINGS_PATH}>See every machine</ActionLink>} /></Card>
      </AdminPage>
    );
  }

  const named = live.length > 0 ? live : runners;
  const name = claim?.name ?? (named.length === 0 ? 'A machine' : named.map((runner) => runner.name).join(' and '));
  const verdict = machineVerdict(claim, runners, Date.now(), nameOf, runnersRead.legacy);
  const first = named[0];
  const owner = claim !== null
    ? ownerWords({ memberId: claim.memberId, viewerId, name: nameOf(claim.memberId) }, { at: claim.firstSeenAt, registered: false })
    : first !== undefined ? ownerWords({ memberId: first.createdBy, viewerId, name: nameOf(first.createdBy) }, { at: first.createdAt, registered: true }) : null;
  const working = live.length > 0 || runnersRead.legacy.length > 0;
  const work = <WorkPart runners={runners} legacy={runnersRead.legacy} storedUsable={runnersRead.storedUsable} read={runnersRead} captureContinues={claim !== null && claim.standing === 'allowed'} />;
  const capture = claimRead !== null && claimRead.error != null
    ? <ErrorState error={claimRead.error} onRetry={() => void claimRead.refetch()}><p>What it captures couldn’t be read.</p></ErrorState>
    : <CapturePart claim={claim} viewerId={viewerId} />;

  return (
    <AdminPage name="machine" title={name} actions={<MachineMenu claim={claim} />}>
      {crumbs}
      <Card className="flex items-start gap-s3" data-machine-verdict={verdict.label}>
        <span className="flex h-lh shrink-0 items-center t-h3"><HealthDot tone={verdict.tone} label={verdict.label} /></span>
        <div className="flex min-w-0 flex-col gap-s1">
          <p className="t-h3 text-ink">{verdict.label}</p>
          <p className="t-small text-ink-2">{verdict.line}{owner === null ? '' : ` ${owner}`}</p>
          {claim !== null && live.length > 0 && <p className="t-small text-muted">{`It runs Myco’s work as ${live.map((runner) => runner.name).join(' and ')}.`}</p>}
          {live.map((runner) => {
            const facts = [runner.os, runner.arch, runner.version === null ? null : `version ${runner.version}`].filter((fact): fact is string => fact !== null);
            return facts.length === 0 ? null : <p key={runner.id} className="t-meta text-faint" data-machine-reported="">{`${live.length > 1 ? `${runner.name} reported` : 'It reported'} ${facts.join(', ')}.`}</p>;
          })}
        </div>
      </Card>
      {working ? <>{work}{capture}</> : <>{capture}{work}</>}
      <CurrentPart claim={claim} runners={runners} viewerId={viewerId} />
      <StopCapturePart claim={claim} runnersContinue={live.map((runner) => runner.name)} />
    </AdminPage>
  );
}
