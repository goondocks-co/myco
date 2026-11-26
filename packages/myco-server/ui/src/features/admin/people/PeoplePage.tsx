/**
 * The people on Settings › People and machines: each person with their role and how they sign in, managed from their
 * row through the dialogs here; the invitations still open; and the sign-ins Myco's own runs used.
 */
import { useState, type ReactNode } from 'react';
import { INVITE_CONTROLS, MEMBER_KEEPS_MACHINES } from '@goondocks/myco-shared/member-protocol';
import {
  ActionMenu, Avatar, Button, Card, CommandBlock, ConfirmDialog, Dialog, DialogContent, DialogFooter, Disclosure, EmptyState, ErrorState, Input, LoadingState, MoreMenu,
  ShowMore, type ActionMenuItem,
} from '../../../design';
import { refusalText, useAccessActions, type useInvitations } from '../../../hooks/use-access';
import { useMe } from '../../../hooks/use-me';
import { usePaged } from '../../../hooks/use-paged';
import { ApiError } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { memberName } from '../members';
import type { CredentialRow, InvitationRow, MemberRow } from '../wire';
import { invitationExpiry, machinesCount } from './words';
import { agoWords } from '@goondocks/myco-shared/time-words';

/**
 * A person's name on this page: the name the server gives them (a label, else
 * their GitHub login); else "You" for the viewer and "A teammate" for anyone
 * else. Never an id.
 */
export function personName(member: Pick<MemberRow, 'id' | 'label' | 'system'>, viewerId: string | null): string {
  return memberName(member) ?? (member.id === viewerId ? 'You' : 'A teammate');
}

/** `personName` with the signed-in viewer filled in. */
export function usePersonName(): (member: Pick<MemberRow, 'id' | 'label' | 'system'>) => string {
  const viewerId = useMe().data?.member?.id ?? null;
  return (member) => personName(member, viewerId);
}

const ROLE_WORDS = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/** A person's line: how they sign in, and, to an admin, how many machines write for them. */
function personLine(member: MemberRow, showMachineCount: boolean): string {
  const signIn = member.linked ? 'Signs in with GitHub' : 'No GitHub account connected yet, so they can’t sign in here';
  return showMachineCount && typeof member.liveMachines === 'number' ? `${signIn} · ${machinesCount(member.liveMachines)}` : signIn;
}

export interface PeopleListProps {
  live: MemberRow[];
  /** People a restore from another server listed without access, until the owner re-admits them. */
  held: MemberRow[];
  removed: MemberRow[];
  viewerId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  ownerMemberId: string | null;
  nameOf: (id: string | null | undefined) => string | null;
  onAddMachine: (memberId: string) => void;
  /** The list's closing row: how another person joins. */
  footer?: ReactNode;
}

/**
 * Each person who can sign in, with their role and how they sign in, and Manage holding what an admin may do to them,
 * each behind its own dialog; the people a restore is holding, and those removed, below.
 */
export function PeopleList({ live, held, removed, viewerId, isAdmin, isOwner, ownerMemberId, nameOf, onAddMachine, footer }: PeopleListProps) {
  const nameOfPerson = usePersonName();
  const actions = useAccessActions();
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [linking, setLinking] = useState<MemberRow | null>(null);
  const [roleReview, setRoleReview] = useState<MemberRow | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [roleConfirmed, setRoleConfirmed] = useState(false);
  const [roleStale, setRoleStale] = useState(false);
  const [readmitting, setReadmitting] = useState<MemberRow | null>(null);
  const [readmitError, setReadmitError] = useState<string | null>(null);
  const self = removing !== null && removing.id === viewerId;
  const removingName = removing === null ? '' : nameOfPerson(removing);

  return (
    <div className="flex flex-col gap-s3">
      <Card padding="flush" className="flex flex-col divide-y divide-line" role="group" aria-label="Who can sign in?">
        {live.length === 0 ? <EmptyState title="Nobody has joined yet." /> : (
          <ul aria-label="Members" className="flex flex-col divide-y divide-line">
            {live.map((member) => (
              <PersonItem
                key={member.id}
                member={member}
                viewerId={viewerId}
                showMachineCount={isAdmin}
                actions={[
                  ...(isAdmin && !member.linked ? [{ label: 'Connect GitHub', onSelect: () => setLinking(member) }] : []),
                  ...(isAdmin && member.id !== viewerId ? [{ label: `${INVITE_CONTROLS.button} for them`, onSelect: () => onAddMachine(member.id) }] : []),
                  ...(isOwner && member.id !== viewerId ? [{ label: member.role === 'admin' ? 'Make member' : 'Make admin', onSelect: () => { setRoleError(null); setRoleStale(false); setRoleConfirmed(false); actions.changeRole.reset(); setRoleReview(member); } }] : []),
                  ...(isAdmin && member.id !== ownerMemberId && !(isOwner && member.id === viewerId) && (member.role === 'member' || isOwner) ? [{ label: 'Remove', onSelect: () => { setRemoveError(null); actions.revokeMember.reset(); setRemoving(member); } }] : []),
                ]}
              />
            ))}
          </ul>
        )}
        {footer}
      </Card>
      {held.length > 0 && (
        <Card padding="flush">
          <ul aria-label="Waiting to be re-admitted" className="flex flex-col divide-y divide-line">
            {held.map((member) => (
              <li key={member.id} className="flex items-center gap-s3 px-s4 py-s3" data-person-held="">
                <Avatar name={nameOfPerson(member)} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="t-body text-ink-2">{nameOfPerson(member)}</span>
                  <span className="t-small text-muted">From another server’s backup. They can’t sign in until the owner re-admits them.</span>
                </div>
                {isOwner && <Button onClick={() => { setReadmitError(null); actions.changeRole.reset(); setReadmitting(member); }}>Re-admit</Button>}
              </li>
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
                      <span className="t-small text-muted">Removed {agoWords(member.revokedAt!, Date.now())}{by === null ? '' : ` by ${by}`}</span>
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
        confirmLabel={self ? 'Remove myself' : 'Remove from this server'}
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
      <ConfirmDialog
        open={roleReview !== null}
        onOpenChange={(open) => { if (!open) { setRoleReview(null); setRoleConfirmed(false); setRoleError(null); setRoleStale(false); } }}
        title={roleReview?.role === 'admin' ? `Make ${roleReview === null ? '' : nameOfPerson(roleReview)} a member?` : `Make ${roleReview === null ? '' : nameOfPerson(roleReview)} an admin?`}
        description={roleReview?.role === 'admin'
          ? 'They will lose server administration powers. Their membership and data stay.'
          : 'They will gain server administration powers. Only the owner can change roles or transfer ownership.'}
        confirmLabel={roleReview?.role === 'admin' ? 'Make member' : 'Make admin'}
        confirmDisabled={!roleConfirmed || roleStale}
        pending={actions.changeRole.isPending}
        error={roleError}
        onConfirm={() => {
          if (roleReview === null || !roleConfirmed) return;
          setRoleError(null);
          actions.changeRole.mutate({ memberId: roleReview.id, role: roleReview.role === 'admin' ? 'member' : 'admin', expectedRevision: roleReview.roleRevision }, {
            onSuccess: () => { setRoleReview(null); setRoleConfirmed(false); },
            onError: (failure) => {
              const stale = failure instanceof ApiError && failure.code === 'revision_conflict';
              setRoleConfirmed(false);
              setRoleStale(stale);
              setRoleError(stale ? 'Nothing changed: their role changed while this was open. Close this and review the refreshed person before trying again.' : refusalText(failure));
            },
          });
        }}
      >
        <label className="flex items-start gap-s2 t-small"><Input type="checkbox" className="size-s4 shrink-0 px-0" checked={roleConfirmed} onChange={(event) => setRoleConfirmed(event.target.checked)} />I reviewed this role change.</label>
      </ConfirmDialog>
      <ConfirmDialog
        open={readmitting !== null}
        onOpenChange={(open) => { if (!open) setReadmitting(null); }}
        title={`Re-admit ${readmitting === null ? '' : nameOfPerson(readmitting)}?`}
        description={`They can sign in with their GitHub account again, as ${readmitting?.role === 'admin' ? 'an admin' : 'a member'}. Their machines need adding again.`}
        confirmLabel="Re-admit"
        tone="primary"
        pending={actions.changeRole.isPending}
        error={readmitError}
        onConfirm={() => {
          if (readmitting === null) return;
          actions.changeRole.mutate({ memberId: readmitting.id, role: readmitting.role, expectedRevision: readmitting.roleRevision }, {
            onSuccess: () => setReadmitting(null),
            onError: (failure) => setReadmitError(refusalText(failure)),
          });
        }}
      />
    </div>
  );
}

function PersonItem({ member, viewerId, showMachineCount, actions }: { member: MemberRow; viewerId: string | null; showMachineCount: boolean; actions: ActionMenuItem[] }) {
  const nameOfPerson = usePersonName();
  const name = nameOfPerson(member);
  const role = ROLE_WORDS[member.effectiveRole ?? member.role];
  return (
    <li className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-person="" data-list-row="person">
      <div className="flex min-w-0 items-start gap-s3">
        <Avatar name={name} />
        <div className="flex min-w-0 flex-col gap-s1">
          <span className="t-body font-medium text-ink break-words">
            {name}
            <span className="t-small font-normal text-muted">{` · ${role}${member.id === viewerId && name !== 'You' ? ' · you' : ''}`}</span>
          </span>
          <span className="t-small text-muted">{personLine(member, showMachineCount)}</span>
        </div>
      </div>
      {actions.length === 1 && <div className="shrink-0"><Button onClick={actions[0]!.onSelect}>{actions[0]!.label}</Button></div>}
      {actions.length > 1 && <div className="shrink-0"><ActionMenu label="Manage" items={actions} /></div>}
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

/** The invitations made here that nobody has used yet, each withdrawn from its menu behind a confirm. */
export function Invitations({ invitations, viewerId, nameOf, people }: InvitationsProps) {
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
        description="Its link stops working at once, so nobody can join with it. Nothing else changes; you can make a new one any time."
        confirmLabel="Withdraw invitation"
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
export function RunCredentials() {
  const runs = usePaged<CredentialRow>(['credentials', 'run'], '/api/credentials?purpose=run&limit=50', { freshness: 'still' });
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
          <ul aria-label="Sign-ins of Myco’s runs" className="flex flex-col divide-y divide-line">
            {runs.rows.map((credential) => (
              <li key={credential.id} className="flex items-center gap-s3 px-s4 py-s2" data-run-credential="">
                <span className="min-w-0 flex-1 t-small text-ink-2">
                  A run started {agoWords(credential.lineageStartedAt, now)} · {credential.live ? 'allowed to write' : 'stopped'}
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
        confirmLabel="Stop its sign-in"
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
