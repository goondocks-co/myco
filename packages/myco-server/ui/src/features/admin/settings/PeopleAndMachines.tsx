import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { dayWords } from '@goondocks/myco-shared/time-words';
import { ActionLink, Button, ErrorState, Link, LoadingState, StatusChip, type Tone } from '../../../design';
import { useMembers } from '../../../hooks/use-access';
import { useMe } from '../../../hooks/use-me';
import { useWorkerFleet } from '../../../hooks/use-status';
import { fetchJson } from '../../../lib/api';
import { harnessLabel } from '../../../lib/harness';
import { live } from '../../../lib/live';
import { MY_MACHINES_PATH, PEOPLE_PATH, SETTINGS_SECTIONS } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { machineOfWorker, useMachines, type Machine } from '../machines';
import { peopleOf } from '../members';
import { InviteDialog, type InviteTarget } from '../people/InviteDialog';
import { AUTO_JOIN_ROOTS_LEAF } from '../people/MachineSettingsDialog';
import { PEOPLE_ANCHORS, usePersonName } from '../people/PeoplePage';
import { machinesCount } from '../people/words';
import type { MemberRow } from '../wire';

/** Where People and machines' sign-in list sits, where an older link to Sign-in and access lands. */
export const SIGN_IN_ANCHOR = 'sign-in';
const OWNER_ACTIONS = `${SETTINGS_SECTIONS.find((section) => section.id === 'advanced')!.to}#owner-actions`;
/** How long a machine stays "Capturing" after it last captured anything. */
const CAPTURING_MS = 86_400_000;

/** One row of the short lists: a name, a line about it, and its state and actions at the right. */
function ListRow({ name, line, children, data }: { name: ReactNode; line: ReactNode; children: ReactNode; data?: string }) {
  return (
    <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-list-row={data}>
      <div className="flex min-w-0 flex-col gap-s1">
        <span className="t-body font-medium text-ink break-words">{name}</span>
        <span className="t-small text-muted">{line}</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-s2">{children}</div>
    </div>
  );
}

/** The closing row of a list: one line on what adding means, and the button that adds. */
function AddRow({ words, children }: { words: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
      <p className="max-w-measure t-small text-muted">{words}</p>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const ROLE_WORDS = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/** A person's line: how they sign in, and how many machines write for them. */
function personLine(member: MemberRow): string {
  const signIn = member.linked ? 'Signs in with GitHub' : 'No GitHub account connected yet, so they can’t sign in here';
  return typeof member.liveMachines === 'number' ? `${signIn} · ${machinesCount(member.liveMachines)}` : signIn;
}

/** "Who can sign in?": each person with their role, how they sign in and their machines, and inviting another. */
function WhoCanSignIn({ onInvite }: { onInvite: () => void }) {
  const members = useMembers();
  const viewerId = useMe().data?.member?.id ?? null;
  const nameOf = usePersonName();
  const people = peopleOf(members.data?.members ?? []).filter((member) => member.revokedAt === null);
  return (
    <AdminSection id={SIGN_IN_ANCHOR} title="Who can sign in?">
      {members.isError && <ErrorState error={members.error} onRetry={() => void members.refetch()} />}
      <RowCard label="Who can sign in?">
        {members.isPending && <LoadingState label="Reading the members" count={2} />}
        {people.map((member) => (
          <ListRow key={member.id} data="person" name={<>
            {nameOf(member)}
            <span className="t-small font-normal text-muted">{` · ${ROLE_WORDS[member.effectiveRole ?? member.role]}${member.id === viewerId ? ' · you' : ''}`}</span>
          </>} line={personLine(member)}>
            <ActionLink to={`${PEOPLE_PATH}#${PEOPLE_ANCHORS.people}`}>Manage</ActionLink>
          </ListRow>
        ))}
        <AddRow words="A teammate signs in with their own GitHub account from a link you send.">
          <Button variant="primary" onClick={onInvite}>{INVITE_CONTROLS.invite}</Button>
        </AddRow>
      </RowCard>
    </AdminSection>
  );
}

interface MachineLeafRow { leaf: string; effective?: unknown }

/** What a machine's own settings say of it: whether it updates itself, and the folders whose repositories it captures. */
function useMachineFacts(machineId: string | null): { updates: string | null; folders: string[] } {
  const settings = useQuery({
    queryKey: ['machine-settings', machineId],
    enabled: machineId !== null,
    queryFn: ({ signal }) => fetchJson<{ leaves: MachineLeafRow[] }>(`/api/machines/${encodeURIComponent(machineId!)}/settings`, signal),
    ...live('still'),
  });
  const leaf = (name: string) => settings.data?.leaves.find((row) => row.leaf === name)?.effective;
  const automatic = leaf('update.automatic');
  const folders = leaf(AUTO_JOIN_ROOTS_LEAF);
  return {
    updates: automatic === true ? 'updates itself' : automatic === false ? 'updates when you update it' : null,
    folders: Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === 'string') : [],
  };
}

/** Whether a machine has captured lately, as a chip. */
function captureState(machine: Machine, now: number): { words: string; tone: Tone } {
  if (machine.lastCaptureAt === null) return { words: 'Nothing captured lately', tone: 'neutral' };
  if (now - machine.lastCaptureAt < CAPTURING_MS) return { words: 'Capturing', tone: 'ok' };
  return { words: `Quiet since ${dayWords(machine.lastCaptureAt, now)}`, tone: 'neutral' };
}

/** One of the viewer's machines: what it captures, how it updates, whether it also runs Myco's work, and its state. */
function MachineRow({ machine, runner }: { machine: Machine; runner: boolean }) {
  const facts = useMachineFacts(machine.machineId);
  const now = Date.now();
  const state = captureState(machine, now);
  const line = [
    machine.capturedAgents.length === 0 ? 'Has not captured an agent lately' : `Captures ${machine.capturedAgents.map(harnessLabel).join(', ')}`,
    facts.updates,
    facts.folders.length === 0 ? null : `captures repositories under ${facts.folders.join(', ')}`,
    runner ? 'also a runner' : null,
  ].filter(Boolean).join(' · ');
  return (
    <ListRow data="machine" name={machine.name} line={line}>
      <StatusChip tone={state.tone}>{state.words}</StatusChip>
      <ActionLink to={MY_MACHINES_PATH}>Manage</ActionLink>
    </ListRow>
  );
}

/** "Your machines": each of the viewer's machines that may write now, and adding another. */
function YourMachines({ onAdd }: { onAdd: () => void }) {
  const viewerId = useMe().data?.member?.id ?? null;
  const machines = useMachines();
  const fleet = useWorkerFleet();
  const own = machines.machines.filter((machine) => machine.memberId === viewerId && machine.standing === 'allowed');
  const runs = (machine: Machine) => (fleet?.fleet ?? []).some((worker) => worker.runnerDetails !== undefined && machineOfWorker([machine], worker) !== undefined);
  return (
    <AdminSection id="your-machines" title="Your machines">
      {machines.error != null && <ErrorState error={machines.error} onRetry={machines.retry} />}
      <RowCard label="Your machines">
        {machines.isPending && <LoadingState label="Reading your machines" count={2} />}
        {own.map((machine) => <MachineRow key={machine.key} machine={machine} runner={runs(machine)} />)}
        {!machines.isPending && own.length === 0 && <p className="px-s4 py-s4 t-small text-muted">None of your machines can write here now.</p>}
        <AddRow words="A machine you add signs in from a one-time link and starts capturing what its agents do.">
          <Button onClick={onAdd}>{INVITE_CONTROLS.button}</Button>
        </AddRow>
      </RowCard>
      <p className="t-small text-muted">
        Transferring ownership and claiming raw data with no recorded uploader are under <Link to={OWNER_ACTIONS}>Advanced › Owner actions</Link>.
      </p>
    </AdminSection>
  );
}

/**
 * People and machines: the short list of who can sign in and of the viewer's own machines, each leading to the page
 * that manages it, with inviting a teammate and adding a machine through the same dialog those pages use.
 */
export function PeopleAndMachines() {
  const viewerId = useMe().data?.member?.id ?? null;
  const members = useMembers();
  const nameOf = usePersonName();
  const [invite, setInvite] = useState<InviteTarget | null>(null);
  const people = peopleOf(members.data?.members ?? []).filter((member) => member.revokedAt === null)
    .map((member) => ({ id: member.id, name: nameOf(member) }))
    .sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  return (
    <>
      <WhoCanSignIn onInvite={() => setInvite({ kind: 'invite' })} />
      <YourMachines onAdd={() => setInvite({ kind: 'machine', memberId: viewerId ?? undefined })} />
      <InviteDialog target={invite} onClose={() => setInvite(null)} people={people} />
    </>
  );
}
