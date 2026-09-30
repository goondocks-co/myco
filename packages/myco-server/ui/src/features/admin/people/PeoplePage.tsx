import { useState } from 'react';
import { INVITE_CONTROLS, MEMBER_KEEPS_MACHINES } from '@goondocks/myco-shared/member-protocol';
import {
  Avatar, Button, Card, CommandBlock, ConfirmDialog, Dialog, DialogContent, DialogFooter, Disclosure, EmptyState, ErrorState, LoadingState, MoreMenu,
  ShowMore, StatusChip, type MoreMenuItem,
} from '../../../design';
import { refusalText, useAccessActions, useInvitations, useMembers } from '../../../hooks/use-access';
import { useMe } from '../../../hooks/use-me';
import { usePaged } from '../../../hooks/use-paged';
import { formatDateTime } from '../../../lib/format';
import { ago } from '../../today/words';
import { AdminPage, AdminSection, useAnchorScroll } from '../AdminFrame';
import { useMachines } from '../machines';
import { memberName, peopleOf, useMemberNames } from '../members';
import type { CredentialRow, InvitationRow, MemberRow } from '../wire';
import { InviteDialog, type InviteTarget } from './InviteDialog';
import { MachineList } from './MachineList';
import { invitationExpiry, machinesCount, shortDate } from './words';

/** Where each part of People & machines sits on its page. */
export const PEOPLE_ANCHORS = { people: 'people', invitations: 'invitations', machines: 'machines', runs: 'runs' } as const;

/**
 * A person's name on this page: their label when it names them; for the
 * viewer, the GitHub login they signed in with; else "A teammate". Never an id.
 */
export function personName(member: Pick<MemberRow, 'id' | 'label' | 'system'>, viewerId: string | null, viewerLogin: string | null = null): string {
  const named = memberName(member);
  if (named !== null) return named;
  if (member.id === viewerId) return viewerLogin !== null && viewerLogin !== '' ? viewerLogin : 'You';
  return 'A teammate';
}

/** `personName` with the signed-in viewer filled in. */
export function usePersonName(): (member: Pick<MemberRow, 'id' | 'label' | 'system'>) => string {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const login = me.data?.login ?? null;
  return (member) => personName(member, viewerId, login);
}

/**
 * `/people`: who is a member, the invitations still open, the machines that
 * write here, and the credentials Myco's own runs hold. An admin invites a
 * teammate or adds a machine from the two actions at the top, each ending in
 * the exact command to run.
 */
export function PeoplePage() {
  const me = useMe();
  const viewerId = me.data?.member?.id ?? null;
  const members = useMembers();
  const invitations = useInvitations();
  const machines = useMachines();
  const nameOf = useMemberNames();
  const nameOfPerson = usePersonName();
  const [invite, setInvite] = useState<InviteTarget | null>(null);
  useAnchorScroll(members.isSuccess && !machines.isPending);

  const all = members.data?.members ?? [];
  const people = peopleOf(all);
  const live = people.filter((m) => m.revokedAt === null);
  const removed = people.filter((m) => m.revokedAt !== null);
  const choices = live.map((m) => ({ id: m.id, name: nameOfPerson(m) }));
  // The viewer first, so adding a machine starts on their own.
  choices.sort((a, b) => Number(b.id === viewerId) - Number(a.id === viewerId));
  const machineCount = (memberId: string) => machines.machines.filter((m) => m.memberId === memberId && m.standing === 'allowed').length;

  return (
    <AdminPage
      name="people"
      title={INVITE_CONTROLS.page}
      lede="Who is a member of this server, and the machines that write to it. Every change names who made it."
      actions={(
        <>
          <Button variant="primary" onClick={() => setInvite({ kind: 'invite' })}>{INVITE_CONTROLS.invite}</Button>
          <Button onClick={() => setInvite({ kind: 'machine', memberId: viewerId ?? undefined })}>{INVITE_CONTROLS.button}</Button>
        </>
      )}
    >
      <AdminSection id={PEOPLE_ANCHORS.people} title="People" description="Everyone who can sign in here. Myco’s own work signs in as Myco, which is not listed.">
        {members.isPending ? <LoadingState label="Reading the members" count={3} />
          : members.isError ? <ErrorState error={members.error} onRetry={() => void members.refetch()} />
          : (
            <PeopleList
              live={live}
              removed={removed}
              viewerId={viewerId}
              nameOf={nameOf}
              machineCount={machineCount}
              onAddMachine={(memberId) => setInvite({ kind: 'machine', memberId })}
            />
          )}
      </AdminSection>

      <AdminSection id={PEOPLE_ANCHORS.invitations} title="Open invitations" description="Links made here that nobody has used yet. Each works once.">
        <Invitations invitations={invitations} viewerId={viewerId} nameOf={nameOf} people={people} />
      </AdminSection>

      <AdminSection id={PEOPLE_ANCHORS.machines} title="Machines" description="Each machine that signed in, whose it is, and whether it may write now.">
        <MachineList
          machines={machines.machines}
          viewerId={viewerId}
          nameOf={nameOf}
          showOwner
          paging={machines}
          empty="No machine has signed in yet."
        />
      </AdminSection>

      <AdminSection id={PEOPLE_ANCHORS.runs} title="Myco’s runs" description="Each task Myco runs signs in with a credential of its own, which stops when its run ends. These belong to runs, not to machines.">
        <RunCredentials />
      </AdminSection>

      <InviteDialog target={invite} onClose={() => setInvite(null)} people={choices} />
    </AdminPage>
  );
}

interface PeopleListProps {
  live: MemberRow[];
  removed: MemberRow[];
  viewerId: string | null;
  nameOf: (id: string | null | undefined) => string | null;
  machineCount: (memberId: string) => number;
  onAddMachine: (memberId: string) => void;
}

function PeopleList({ live, removed, viewerId, nameOf, machineCount, onAddMachine }: PeopleListProps) {
  const nameOfPerson = usePersonName();
  const actions = useAccessActions();
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [linking, setLinking] = useState<MemberRow | null>(null);
  const self = removing !== null && removing.id === viewerId;
  const removingName = removing === null ? '' : nameOfPerson(removing);

  return (
    <div className="flex flex-col gap-s3">
      {live.length === 0 ? <EmptyState title="Nobody has joined yet." /> : (
        <Card padding="flush">
          <ul aria-label="Members" className="flex flex-col divide-y divide-line">
            {live.map((member) => (
              <PersonItem
                key={member.id}
                member={member}
                viewerId={viewerId}
                machines={machineCount(member.id)}
                actions={[
                  ...(!member.linked ? [{ label: 'Connect GitHub', onSelect: () => setLinking(member) }] : []),
                  { label: `${INVITE_CONTROLS.button} for them`, onSelect: () => onAddMachine(member.id) },
                  { label: 'Remove', tone: 'danger' as const, onSelect: () => { setRemoveError(null); actions.revokeMember.reset(); setRemoving(member); } },
                ]}
              />
            ))}
          </ul>
        </Card>
      )}
      {removed.length > 0 && (
        <Disclosure summary={`Removed (${removed.length})`}>
          <Card padding="flush">
            <ul aria-label="Removed members" className="flex flex-col divide-y divide-line">
              {removed.map((member) => {
                const by = nameOf(member.revokedBy);
                return (
                  <li key={member.id} className="flex items-center gap-s3 px-s4 py-s3">
                    <Avatar name={nameOfPerson(member)} />
                    <div className="flex min-w-0 flex-col">
                      <span className="t-body text-ink-2">{nameOfPerson(member)}</span>
                      <span className="t-small text-muted">Removed {ago(member.revokedAt!, Date.now())}{by === null ? '' : ` by ${by}`}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </Disclosure>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={self ? 'Remove yourself?' : `Remove ${removingName}?`}
        description={self
          ? 'This is you. Your machines stop writing, your invitations are withdrawn, and you can no longer sign in. Your history stays.'
          : `Their machines stop writing at once, their open invitations are withdrawn, and they can no longer sign in. Their history stays. ${MEMBER_KEEPS_MACHINES}`}
        confirmLabel="Remove"
        pending={actions.revokeMember.isPending}
        error={removeError}
        onConfirm={() => {
          if (removing === null) return;
          const target = removing;
          actions.revokeMember.mutate(target.id, {
            onSuccess: () => { setRemoving(null); if (target.id === viewerId) window.location.assign('/'); },
            onError: (err) => setRemoveError(refusalText(err)),
          });
        }}
      />
      <ConnectGithubDialog member={linking} name={linking === null ? '' : nameOfPerson(linking)} onClose={() => setLinking(null)} />
    </div>
  );
}

function PersonItem({ member, viewerId, machines, actions }: { member: MemberRow; viewerId: string | null; machines: number; actions: MoreMenuItem[] }) {
  const nameOfPerson = usePersonName();
  const name = nameOfPerson(member);
  return (
    <li className="flex items-center gap-s3 px-s4 py-s3" data-person="">
      <Avatar name={name} />
      <div className="flex min-w-0 flex-1 flex-col gap-s1">
        <span className="flex flex-wrap items-center gap-s2">
          <span className="t-body font-medium text-ink">{name}</span>
          {member.role === 'admin' && <StatusChip>Admin</StatusChip>}
          {member.id === viewerId && name !== 'You' && <StatusChip>You</StatusChip>}
        </span>
        <span className="t-small text-muted">
          {member.linked ? 'GitHub connected' : 'No GitHub account yet'} · {machinesCount(machines)} · joined {shortDate(member.createdAt)}
        </span>
      </div>
      <MoreMenu label={`More for ${name}`} items={actions} />
    </li>
  );
}

/** A one-time link that connects a GitHub account to a member, sent to them to open. */
function ConnectGithubDialog({ member, name, onClose }: { member: MemberRow | null; name: string; onClose: () => void }) {
  const link = useAccessActions().linkGithub;
  const [issued, setIssued] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => { setIssued(null); setError(null); link.reset(); onClose(); };
  return (
    <Dialog open={member !== null} onOpenChange={(open) => { if (!open) close(); }}>
      {member !== null && (
        <DialogContent
          title={issued === null ? `Connect a GitHub account to ${name}` : 'Link ready'}
          description={issued === null
            ? `Creates a one-time link for ${name}. Whoever opens it and signs in with GitHub connects that account to this member, so send it only to them. An earlier link for them stops working.`
            : `Send this link to ${name}. They open it, sign in with GitHub, and confirm; that account is how they sign in here from then on.`}
        >
          {issued === null ? (
            <>
              {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
              <DialogFooter>
                <Button variant="ghost" onClick={close}>Cancel</Button>
                <Button
                  variant="primary"
                  pending={link.isPending}
                  onClick={() => {
                    setError(null);
                    link.mutate(member.id, {
                      onSuccess: (answer) => setIssued({ url: `${window.location.origin}/link#${answer.key}`, expiresAt: answer.expiresAt }),
                      onError: (err) => setError(refusalText(err)),
                    });
                  }}
                >
                  Create link
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <CommandBlock caption="The sign-in link:" command={issued.url} />
              <p className="t-small text-muted">It works once and expires {formatDateTime(issued.expiresAt)}. Keep it private until {name} has used it.</p>
              <DialogFooter><Button variant="primary" onClick={close}>Done</Button></DialogFooter>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
}

interface InvitationsProps {
  invitations: ReturnType<typeof useInvitations>;
  viewerId: string | null;
  nameOf: (id: string | null | undefined) => string | null;
  people: MemberRow[];
}

function Invitations({ invitations, viewerId, nameOf, people }: InvitationsProps) {
  const nameOfPerson = usePersonName();
  const withdraw = useAccessActions().revokeInvitation;
  const [withdrawing, setWithdrawing] = useState<InvitationRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const forName = (id: string) => {
    const member = people.find((m) => m.id === id);
    if (member === undefined) return 'a member';
    const name = nameOfPerson(member);
    return name === 'A teammate' ? 'a teammate' : name;
  };
  if (invitations.isPending) return <LoadingState label="Reading the invitations" count={1} />;
  if (invitations.isError) return <ErrorState error={invitations.error} onRetry={() => void invitations.refetch()} />;
  const list = invitations.data.invitations;
  const now = Date.now();
  return (
    <>
      {list.length === 0 ? <EmptyState title="No open invitations." /> : (
        <Card padding="flush">
          <ul aria-label="Invitations" className="flex flex-col divide-y divide-line">
            {list.map((invitation) => {
              const by = invitation.createdBy === viewerId ? 'you' : nameOf(invitation.createdBy);
              return (
                <li key={invitation.id} className="flex items-center gap-s3 px-s4 py-s3" data-invitation="">
                  <div className="flex min-w-0 flex-1 flex-col gap-s1">
                    <span className="t-body text-ink">{invitation.memberId === null ? 'A new teammate' : `A machine for ${forName(invitation.memberId)}`}</span>
                    <span className="t-small text-muted">{by === null ? '' : `by ${by} · `}{invitationExpiry(invitation.expiresAt, now)}</span>
                  </div>
                  <MoreMenu label="More for this invitation" items={[{ label: 'Withdraw', tone: 'danger', onSelect: () => { setError(null); withdraw.reset(); setWithdrawing(invitation); } }]} />
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      <ConfirmDialog
        open={withdrawing !== null}
        onOpenChange={(open) => { if (!open) setWithdrawing(null); }}
        title="Withdraw this invitation?"
        description="Its link stops working at once. Nothing else changes."
        confirmLabel="Withdraw"
        pending={withdraw.isPending}
        error={error}
        onConfirm={() => {
          if (withdrawing === null) return;
          withdraw.mutate(withdrawing.id, { onSuccess: () => setWithdrawing(null), onError: (err) => setError(refusalText(err)) });
        }}
      />
    </>
  );
}

/** The credentials Myco's runs signed in with, newest first; a live one can be stopped. */
function RunCredentials() {
  const runs = usePaged<CredentialRow>(['credentials', 'run'], '/api/credentials?purpose=run&limit=50');
  const stop = useAccessActions().revokeCredentials;
  const [stopping, setStopping] = useState<CredentialRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (runs.isPending) return <LoadingState label="Reading Myco’s runs" count={1} />;
  if (runs.error !== null && runs.rows.length === 0) return <ErrorState error={runs.error} onRetry={runs.retry} />;
  if (runs.rows.length === 0) return <Card><EmptyState title="Myco hasn’t run a task yet." className="py-0" /></Card>;
  const liveCount = runs.rows.filter((c) => c.live).length;
  const now = Date.now();
  return (
    <>
      <Disclosure summary={`${runs.rows.length.toLocaleString()} ${runs.rows.length === 1 ? 'run' : 'runs'}, ${liveCount.toLocaleString()} still signed in`}>
        <Card padding="flush">
          <ul aria-label="Run credentials" className="flex flex-col divide-y divide-line">
            {runs.rows.map((credential) => (
              <li key={credential.id} className="flex items-center gap-s3 px-s4 py-s2" data-run-credential="">
                <span className="min-w-0 flex-1 t-small text-ink-2">
                  A run started {ago(credential.lineageStartedAt, now)} · {credential.live ? 'allowed to write' : 'stopped'}
                </span>
                {credential.live && (
                  <MoreMenu label="More for this run" items={[{ label: 'Stop', tone: 'danger', onSelect: () => { setError(null); stop.reset(); setStopping(credential); } }]} />
                )}
              </li>
            ))}
          </ul>
        </Card>
        {(runs.hasMore || runs.isFetchingMore) && <ShowMore shown={runs.rows.length} noun="runs" hasMore={runs.hasMore} pending={runs.isFetchingMore} onMore={runs.more} />}
      </Disclosure>
      <ConfirmDialog
        open={stopping !== null}
        onOpenChange={(open) => { if (!open) setStopping(null); }}
        title="Stop this run’s sign-in?"
        description="The run can no longer write. What it already wrote stays."
        confirmLabel="Stop"
        pending={stop.isPending}
        error={error}
        onConfirm={() => {
          if (stopping === null) return;
          stop.mutate([stopping.id], {
            onSuccess: (outcome) => { if (outcome.failed.length === 0) setStopping(null); else setError(refusalText(outcome.failed[0]!.error)); },
            onError: (err) => setError(refusalText(err)),
          });
        }}
      />
    </>
  );
}
