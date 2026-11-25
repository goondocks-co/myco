import { useState, type ReactNode } from 'react';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { ActionLink, Button, Disclosure, ErrorState, Link, LoadingState, ShowMore, StatusChip, type Tone } from '../../../design';
import { useInvitations, useMembers } from '../../../hooks/use-access';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { useRunnerPages } from '../../../hooks/use-fleet';
import type { RunnerRow } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { machinePath, runnerMachinePath, SETTINGS_SECTIONS } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { useMachines, type Machine } from '../machines';
import { machineVerdict } from '../machine/words';
import { peopleOf, useMemberNames } from '../members';
import { InviteDialog, type InviteTarget } from '../people/InviteDialog';
import { Invitations, PeopleList, personName, RunCredentials } from '../people/PeoplePage';

/** Where People and machines' sign-in list sits, where an older link to Sign-in and access lands. */
export const SIGN_IN_ANCHOR = 'sign-in';
/** Where each part of People and machines sits on its page. */
export const PEOPLE_ANCHORS = { signIn: SIGN_IN_ANCHOR, invitations: 'invitations', machines: 'machines', runs: 'runs' } as const;
const OWNER_ACTIONS = `${SETTINGS_SECTIONS.find((section) => section.id === 'advanced')!.to}#owner-actions`;
const VERDICT_TONE: Readonly<Record<string, Tone>> = { ok: 'ok', warn: 'warn', bad: 'bad' };

/** One row of a list: a name, a line about it, and its state and actions at the right. */
function ListRow({ id, name, line, children, data }: { id?: string; name: ReactNode; line: ReactNode; children: ReactNode; data?: string }) {
  return (
    <div id={id} className="flex scroll-mt-s6 flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-list-row={data}>
      <div className="flex min-w-0 flex-col gap-s1">
        <span className="t-body font-medium text-ink break-words">{name}</span>
        <span className="t-small text-muted">{line}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-s2">{children}</div>
    </div>
  );
}

/** The closing row of a list: one line on what adding means, and the button that adds. */
function AddRow({ words, children }: { words: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
      <p className="max-w-measure t-small text-muted">{words}</p>
      {children != null && <div className="shrink-0">{children}</div>}
    </div>
  );
}

/** "Who can sign in?": each person with their role and how they sign in, managed from their row, and inviting another. */
function WhoCanSignIn({ onInvite, onAddMachine }: { onInvite: () => void; onAddMachine: (memberId: string) => void }) {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const isAdmin = permissionOf(me.data, 'people').allowed;
  const isOwner = permissionOf(me.data, 'roles').allowed;
  const members = useMembers();
  const nameOf = useMemberNames();
  const people = peopleOf(members.data?.members ?? []);
  const live = people.filter((m) => m.revokedAt === null);
  return (
    <AdminSection id={SIGN_IN_ANCHOR} title="Who can sign in?" description="Myco’s own work signs in as Myco, which is not listed.">
      {members.isError && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}
      {members.isPending ? <RowCard><LoadingState label="Reading the members" count={2} /></RowCard> : members.isSuccess && (
        <PeopleList
          live={live}
          held={people.filter((m) => m.revokedAt !== null && m.awaitingAdmission === true)}
          removed={people.filter((m) => m.revokedAt !== null && m.awaitingAdmission !== true)}
          viewerId={viewerId}
          isAdmin={isAdmin}
          isOwner={isOwner}
          ownerMemberId={people.find((member) => member.effectiveRole === 'owner')?.id ?? null}
          nameOf={nameOf}
          onAddMachine={onAddMachine}
          footer={isAdmin
            ? <AddRow words="A teammate signs in with their own GitHub account from a link you send."><Button variant="primary" onClick={onInvite}>{INVITE_CONTROLS.invite}</Button></AddRow>
            : <AddRow words="An admin invites a teammate and changes who can do what." />}
        />
      )}
    </AdminSection>
  );
}

/** One machine: what it captures, whether it also runs Myco's work, its verdict, and Manage, which opens its page. */
function MachineRow({ machine, runners, runnersKnown, owner }: { machine: Machine; runners: readonly RunnerRow[]; runnersKnown: boolean; owner: string | null }) {
  const nameOf = useMemberNames();
  const verdict = machineVerdict(machine, runners, Date.now(), nameOf);
  const live = runners.filter((runner) => runner.state !== 'removed');
  const line = [
    owner,
    machine.standing !== 'allowed' ? 'stopped capturing' : machine.capturedAgents.length === 0 ? 'has not captured an agent lately' : `captures ${machine.capturedAgents.map(harnessLabel).join(', ')}`,
    !runnersKnown ? 'whether it runs Myco’s work is unknown' : live.length > 0 ? `runs Myco’s work as ${live.map((runner) => runner.name).join(' and ')}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <ListRow id={machine.machineId === null ? undefined : `machine-${machine.machineId}`} data="machine" name={machine.name} line={line.charAt(0).toUpperCase() + line.slice(1)}>
      <StatusChip tone={VERDICT_TONE[verdict.tone] ?? 'neutral'}>{verdict.label}</StatusChip>
      {machine.machineId !== null && <ActionLink to={machinePath(machine.machineId)}>Manage</ActionLink>}
    </ListRow>
  );
}

/**
 * "Machines": every machine an admin may see, or a member's own, page by page, each leading to its page; the former
 * ones folded below; to an admin, the runners that are machines of their own once every machine is read; and adding one.
 */
function Machines({ onAdd }: { onAdd: () => void }) {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const isAdmin = permissionOf(me.data, 'people').allowed;
  const nameOf = useMemberNames();
  const machines = useMachines();
  const runners = useRunnerPages({ all: true });
  const runnersKnown = runners.query.isSuccess && !runners.query.hasNextPage;
  const runnersOf = (machine: Machine) => runners.runners.filter((runner) => machine.machineId !== null && runner.machineId === machine.machineId);
  const owner = (machine: Machine) => (machine.memberId === viewerId ? null : `${nameOf(machine.memberId) ?? 'a teammate'}’s`);
  // A machine whose sign-ins stopped stays among the live ones while a runner on it still takes work.
  const live = machines.machines.filter((machine) => machine.standing === 'allowed' || runnersOf(machine).length > 0);
  const former = machines.machines.filter((machine) => !live.includes(machine));
  const claimed = new Set(machines.machines.map((machine) => machine.machineId));
  const read = !machines.isPending && machines.error == null;
  const allRead = read && !machines.hasMore;
  // Runners on machines nobody signed in on: one row per bound machine, and one per registration with none bound.
  const unclaimed = isAdmin && allRead && runnersKnown ? runners.runners.filter((runner) => runner.machineId === null || !claimed.has(runner.machineId)) : [];
  const ownOnly = [...new Map(unclaimed.map((runner) => [runner.machineId ?? `runner:${runner.id}`, unclaimed.filter((other) => runner.machineId !== null && other.machineId === runner.machineId).concat(runner.machineId === null ? [runner] : [])])).entries()];
  const row = (machine: Machine) => <MachineRow key={machine.key} machine={machine} runners={runnersOf(machine)} runnersKnown={runnersKnown} owner={owner(machine)} />;
  return (
    <AdminSection id={PEOPLE_ANCHORS.machines} title={isAdmin ? 'Machines' : 'Your machines'} description={isAdmin ? 'Each machine that signed in or runs Myco’s work, whose it is, and what it is doing.' : 'The machines you signed in from, and what each is doing.'}>
      {machines.error != null && <ErrorState error={machines.error} onRetry={machines.retry} />}
      {runners.query.error != null && <ErrorState error={runners.query.error} onRetry={() => void (runners.query.isFetchNextPageError ? runners.query.fetchNextPage() : runners.query.refetch())}><p>Which machines run Myco’s work couldn’t be read.</p></ErrorState>}
      <RowCard label="Machines">
        {machines.isPending && <LoadingState label="Reading the machines" count={2} />}
        {live.map(row)}
        {ownOnly.map(([key, group]) => {
          const verdict = machineVerdict(null, group);
          const first = group[0]!;
          return (
            <ListRow key={key} id={first.machineId === null ? `runner-${first.id}` : `machine-${first.machineId}`} data="runner-machine" name={group.map((runner) => runner.name).join(' and ')}
              line={`Runs Myco’s work${group.length > 1 ? ` as ${group.length} runners` : ''}; nobody signed in on it to capture`}>
              <StatusChip tone={VERDICT_TONE[verdict.tone] ?? 'neutral'}>{verdict.label}</StatusChip>
              <ActionLink to={first.machineId === null ? runnerMachinePath(first) : machinePath(first.machineId)}>Manage</ActionLink>
            </ListRow>
          );
        })}
        {(machines.hasMore || machines.isFetchingMore) && (
          <div className="flex flex-col gap-s2 px-s4 py-s3">
            {isAdmin && <p className="t-small text-muted">Runners that are machines of their own are listed once every machine is read.</p>}
            <ShowMore shown={machines.machines.length} noun="machines" hasMore={machines.hasMore} pending={machines.isFetchingMore} onMore={machines.more} />
          </div>
        )}
        {allRead && live.length === 0 && ownOnly.length === 0 && <p className="px-s4 py-s4 t-small text-muted">{isAdmin ? 'No machine can write here now.' : 'None of your machines can write here now.'}</p>}
        {former.length > 0 && (
          <div className="px-s4 py-s3">
            <Disclosure summary={`Former machines (${former.length.toLocaleString()})`}>
              <div className="flex flex-col divide-y divide-line" aria-label="Former machines">{former.map(row)}</div>
            </Disclosure>
          </div>
        )}
        {isAdmin
          ? <AddRow words="A machine you add signs in from a one-time link and starts capturing what its agents do."><Button onClick={onAdd}>{INVITE_CONTROLS.button}</Button></AddRow>
          : <AddRow words={`To add a machine, an admin creates a one-time link here with ${INVITE_CONTROLS.button}; you run myco login with it on the new machine.`} />}
      </RowCard>
    </AdminSection>
  );
}

/**
 * People and machines: who can sign in and the machines that write here or run Myco's work, each leading to what
 * manages it; to an admin, the open invitations and the sign-ins Myco's own runs used.
 */
export function PeopleAndMachines() {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const isAdmin = permissionOf(me.data, 'people').allowed;
  const members = useMembers();
  const invitations = useInvitations({ enabled: isAdmin });
  const nameOf = useMemberNames();
  const [invite, setInvite] = useState<InviteTarget | null>(null);
  const all = peopleOf(members.data?.members ?? []);
  const choices = all.filter((member) => member.revokedAt === null)
    .map((member) => ({ id: member.id, name: personName(member, viewerId) }))
    .sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  return (
    <>
      <WhoCanSignIn onInvite={() => setInvite({ kind: 'invite' })} onAddMachine={(memberId) => setInvite({ kind: 'machine', memberId })} />
      {isAdmin && (
        <AdminSection id={PEOPLE_ANCHORS.invitations} title="Open invitations" description="Links made here that nobody has used yet. Each works once.">
          <Invitations invitations={invitations} viewerId={viewerId} nameOf={nameOf} people={all} />
        </AdminSection>
      )}
      <Machines onAdd={() => setInvite({ kind: 'machine', memberId: viewerId ?? undefined })} />
      {isAdmin && (
        <AdminSection id={PEOPLE_ANCHORS.runs} title="Myco’s run sign-ins" description="Each task Myco runs signs in on its own, and the sign-in stops when its run ends. These belong to runs, not to machines.">
          <RunCredentials />
        </AdminSection>
      )}
      {isAdmin && (
        <p className="t-small text-muted" data-owner-actions="">
          Transferring ownership and claiming raw data with no recorded uploader are under <Link to={OWNER_ACTIONS}>Advanced › Owner actions</Link>.
        </p>
      )}
      {isAdmin && <InviteDialog target={invite} onClose={() => setInvite(null)} people={choices} />}
    </>
  );
}
