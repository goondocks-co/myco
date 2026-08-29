import { useState } from 'react';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { SlideoutDetailPanel } from '../components/ui/slideout-detail-panel';
import { StatusDot } from '../components/ui/status-dot';
import { KeyReveal } from '../components/access/KeyReveal';
import { useAccessActions, useInvitations, useMembers, usePaged, type ActivityRow, type CredentialRow } from '../hooks/use-access';
import { useMe } from '../hooks/use-me';
import { ApiError } from '../lib/api';
import { formatCount, formatDateTime, formatRelative } from '../lib/format';

const REFUSALS: Record<string, string> = {
  last_member: 'This is the last member with a connected account; the server would be left with nobody who can sign in.',
  already_revoked: 'Already removed.',
  member_revoked: 'That member has been removed.',
};

function refusalText(err: unknown): string {
  if (err instanceof ApiError) {
    const code = (err.body as { error?: unknown } | null)?.error;
    if (typeof code === 'string' && REFUSALS[code]) return REFUSALS[code];
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90';

/** `/access`: who is a member, who has been invited, and which runtimes write here. */
export function Access() {
  const me = useMe();
  const members = useMembers();
  const invitations = useInvitations();
  const credentials = usePaged<CredentialRow>(['credentials'], '/api/credentials?limit=50');
  const actions = useAccessActions();

  const [revokeMemberId, setRevokeMemberId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteFor, setInviteFor] = useState<string>('');
  const [inviteMinutes, setInviteMinutes] = useState(60);
  const [invited, setInvited] = useState<{ key: string; expiresAt: number } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [openCredential, setOpenCredential] = useState<CredentialRow | null>(null);
  const [revokeCredentialId, setRevokeCredentialId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const list = members.data?.members ?? [];
  const target = list.find((m) => m.id === revokeMemberId);
  const isMe = (id: string) => me.data?.member?.id === id;
  const nameOf = (id: string) => list.find((m) => m.id === id)?.label ?? id;

  return (
    <PageContainer>
      <PageHeader title="Access" subtitle="Members, invitations and runtimes of this server. Everything here is open to every member, and every change names who made it." />
      <PageLoading isLoading={members.isPending} error={members.error}>
        <div className="flex flex-col gap-4">
          <Panel padded title="Members" actions={<button type="button" className={primary} onClick={() => { setInvited(null); setInviteError(null); setInviteFor(''); setInviteOpen(true); }}>Invite</button>}>
            <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Members">
              {list.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                  <StatusDot tone={m.revokedAt !== null ? 'outline' : m.linked ? 'sage' : 'ochre'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-on-surface">{m.label ?? m.id}{isMe(m.id) && <span className="ml-2 font-mono text-[10px] uppercase text-on-surface-variant">you</span>}</div>
                    <div className="font-mono text-[11px] text-on-surface-variant">{m.id}</div>
                  </div>
                  <span className="text-xs text-on-surface-variant">{m.revokedAt !== null ? `removed ${formatRelative(m.revokedAt)} by ${nameOf(m.revokedBy ?? '')}` : m.linked ? 'account connected' : 'no account yet'}</span>
                  <span className="text-xs text-on-surface-variant">{formatCount(m.liveCredentials, 'runtime')}</span>
                  {m.revokedAt === null && (
                    <button type="button" className={button} onClick={() => { setRefusal(null); setRevokeMemberId(m.id); }}>Remove</button>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel padded title="Invitations">
            {(invitations.data?.invitations ?? []).length === 0 ? (
              <p className="font-sans text-sm text-on-surface-variant">No open invitations.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Invitations">
                {invitations.data!.invitations.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="text-on-surface">{i.memberId === null ? 'A new member' : `Another runtime for ${nameOf(i.memberId)}`}</div>
                      <div className="text-xs text-on-surface-variant">by {nameOf(i.createdBy ?? '')} · expires {formatRelative(i.expiresAt)}</div>
                    </div>
                    <button type="button" className={button} onClick={() => actions.revokeInvitation.mutate(i.id)}>Withdraw</button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel padded title="Runtimes">
            <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Runtimes">
              {credentials.rows.map((c) => (
                <li key={c.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                  <StatusDot tone={c.live ? 'sage' : 'outline'} />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenCredential(c)}>
                    <div className="text-on-surface">{c.machineId ?? c.id} <span className="text-xs text-on-surface-variant">· {nameOf(c.memberId)}</span></div>
                    <div className="font-mono text-[11px] text-on-surface-variant">{c.id} · started {formatRelative(c.lineageStartedAt)}</div>
                  </button>
                  <span className="text-xs text-on-surface-variant">{c.live ? 'writing' : c.revokedAt !== null ? `stopped by ${nameOf(c.revokedBy ?? '')}` : 'stopped'}</span>
                  {c.revokedAt === null && <button type="button" className={button} onClick={() => setRevokeCredentialId(c.id)}>Stop</button>}
                </li>
              ))}
            </ul>
            {credentials.hasMore && <button type="button" className={`${button} mt-3`} onClick={credentials.more}>Show more</button>}
            {credentials.rows.length === 0 && !credentials.isPending && <p className="font-sans text-sm text-on-surface-variant">No runtimes have joined yet.</p>}
          </Panel>
        </div>
      </PageLoading>

      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => { if (!open) setRevokeMemberId(null); }}
        title={target && isMe(target.id) ? 'Remove yourself?' : `Remove ${target?.label ?? target?.id ?? ''}?`}
        description={target && isMe(target.id)
          ? 'This is you. Your runtimes stop writing, your invitations are withdrawn, and you can no longer sign in. Your history stays.'
          : 'Their runtimes stop writing at once, their open invitations are withdrawn, and they can no longer sign in. Their history stays.'}
        impact={target ? [{ label: 'runtimes', value: target.liveCredentials }] : undefined}
        confirmLabel="Remove"
        isPending={actions.revokeMember.isPending}
        errorMessage={refusal}
        onConfirm={() => {
          if (!target) return;
          actions.revokeMember.mutate(target.id, {
            onSuccess: () => { setRevokeMemberId(null); if (isMe(target.id)) window.location.assign('/'); },
            onError: (err) => setRefusal(refusalText(err)),
          });
        }}
      />

      <ConfirmDialog
        open={revokeCredentialId !== null}
        onOpenChange={(open) => { if (!open) setRevokeCredentialId(null); }}
        title="Stop this runtime?"
        description="It stops writing at once. What it already wrote stays, attributed to it."
        confirmLabel="Stop"
        isPending={actions.revokeCredential.isPending}
        onConfirm={() => {
          if (revokeCredentialId === null) return;
          actions.revokeCredential.mutate(revokeCredentialId, { onSuccess: () => { setRevokeCredentialId(null); credentials.reset(); } });
        }}
      />

      <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) setInvited(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{invited ? 'Invitation ready' : 'Invite'}</DialogTitle>
            <DialogDescription>{invited ? 'Give this key to the person joining. It works once and expires on its own.' : 'An invitation joins a new member, or adds another runtime to a member already here.'}</DialogDescription>
          </DialogHeader>
          {invited ? (
            <KeyReveal label="Invitation key" value={invited.key} hint={`Expires ${formatDateTime(invited.expiresAt)}. On the joining machine: myco member join <this server> …`} />
          ) : (
            <form className="flex flex-col gap-3" onSubmit={(e) => {
              e.preventDefault();
              setInviteError(null);
              actions.mintInvitation.mutate({ ...(inviteFor === '' ? {} : { memberId: inviteFor }), ttlMinutes: inviteMinutes }, {
                onSuccess: (r) => setInvited({ key: r.key, expiresAt: r.expiresAt }),
                onError: (err) => setInviteError(refusalText(err)),
              });
            }}>
              <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
                For
                <select value={inviteFor} onChange={(e) => setInviteFor(e.target.value)} className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1.5 text-sm text-on-surface">
                  <option value="">A new member</option>
                  {list.filter((m) => m.revokedAt === null).map((m) => <option key={m.id} value={m.id}>Another runtime for {m.label ?? m.id}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
                Valid for (minutes, up to a day)
                <input type="number" min={1} max={1440} value={inviteMinutes} onChange={(e) => setInviteMinutes(Number(e.target.value))} className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1.5 text-sm text-on-surface" />
              </label>
              {inviteError && <p className="font-sans text-xs text-tertiary">{inviteError}</p>}
              <button type="submit" className={primary} disabled={actions.mintInvitation.isPending}>Create invitation</button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <SlideoutDetailPanel open={openCredential !== null} onClose={() => setOpenCredential(null)} ariaLabel="Runtime activity">
        {openCredential && <CredentialActivity credential={openCredential} memberName={nameOf(openCredential.memberId)} />}
      </SlideoutDetailPanel>
    </PageContainer>
  );
}

function CredentialActivity({ credential, memberName }: { credential: CredentialRow; memberName: string }) {
  const activity = usePaged<ActivityRow>(['credential-activity', credential.id], `/api/credentials/${encodeURIComponent(credential.id)}/activity?limit=50`);
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="font-serif text-lg text-on-surface">{credential.machineId ?? credential.id}</div>
        <div className="font-sans text-xs text-on-surface-variant">{memberName} · {credential.live ? 'writing' : 'stopped'} · {(credential.bytesWritten / 1_048_576).toFixed(1)} MB written</div>
      </div>
      <PageLoading isLoading={activity.isPending} error={activity.error}>
        {activity.rows.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant">Nothing written yet.</p>
        ) : (
          <table className="w-full font-sans text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-on-surface-variant"><tr><th>When</th><th>Project</th><th>Kind</th><th>Session</th></tr></thead>
            <tbody>
              {activity.rows.map((a) => (
                <tr key={a.eventId} className="border-t border-outline-variant/10">
                  <td className="py-1 text-on-surface-variant">{formatRelative(a.createdAt)}</td>
                  <td className="py-1 font-mono text-on-surface">{a.projectId}</td>
                  <td className="py-1 text-on-surface-variant">{a.kind}</td>
                  <td className="py-1 font-mono text-on-surface-variant">{a.sessionId.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {activity.hasMore && <button type="button" className={`${button} mt-2`} onClick={activity.more}>Show more</button>}
      </PageLoading>
    </div>
  );
}
