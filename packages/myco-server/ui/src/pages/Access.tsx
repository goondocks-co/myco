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
import { refusalText, useAccessActions, useInvitations, useMembers, usePaged, type ActivityRow, type CredentialRow } from '../hooks/use-access';
import { useMe } from '../hooks/use-me';
import { useProjects } from '../hooks/use-projects';
import { useWorkerFleet } from '../hooks/use-status';
import { formatCount, formatDateTime, formatRelative, formatUntil } from '../lib/format';
import { FLEET_UNKNOWN_WORDS, offersWords, REASON_WORDS, workerFor, workerState, type FleetLookup } from '../lib/worker-state';

/** What a captured event is, in the person's words. */
const KIND_LABEL: Record<string, string> = {
  'session.start': 'Session started', 'session.end': 'Session ended', prompt: 'Prompt', 'tool.use': 'Tool call', 'tool.failure': 'Tool failed',
  response: 'Response', plan: 'Plan', attachment: 'Attachment', 'transcript.segment': 'Transcript', 'compaction.pre': 'Compaction', 'compaction.post': 'Compaction',
  'subagent.start': 'Subagent started', 'subagent.stop': 'Subagent stopped', 'stop.failure': 'Stop failed', 'task.completed': 'Task completed', notification: 'Notification', error: 'Error',
};

/** What a credential's own record allows: whether it would authenticate, never whether it is writing. */
function credentialWords(credential: CredentialRow, revokedByName: string | null): string {
  if (credential.revokedAt !== null) return `stopped${revokedByName === null ? '' : ` by ${revokedByName}`}`;
  return credential.live ? 'allowed to write' : 'expired';
}

/** When an open invitation stops working. The list holds only unexpired ones, so a past one has lapsed since it loaded. */
export function invitationExpiry(expiresAt: number, now: number): string {
  return expiresAt <= now ? 'expired' : `expires in ${formatUntil(expiresAt, now)}`;
}

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90';

/** `/access`: who is a member, who has been invited, and which runtimes write here. */
export function Access() {
  const me = useMe();
  const members = useMembers();
  const invitations = useInvitations();
  // Each purpose is paged on its own.
  const credentials = usePaged<CredentialRow>(['credentials', 'member'], '/api/credentials?purpose=member&limit=50');
  const runCredentials = usePaged<CredentialRow>(['credentials', 'run'], '/api/credentials?purpose=run&limit=50');
  const fleet = useWorkerFleet();
  const actions = useAccessActions();

  const [revokeMemberId, setRevokeMemberId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteFor, setInviteFor] = useState<string>('');
  const [inviteMinutes, setInviteMinutes] = useState(60);
  const [invited, setInvited] = useState<{ key: string; expiresAt: number } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [openCredentialId, setOpenCredentialId] = useState<string | null>(null);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const [revokeCredentialId, setRevokeCredentialId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const list = members.data?.members ?? [];
  const target = list.find((m) => m.id === revokeMemberId);
  const isMe = (id: string) => me.data?.member?.id === id;
  const nameOf = (id: string | null) => (id === null ? null : list.find((m) => m.id === id)?.label ?? id);
  const openCredential = [...credentials.rows, ...runCredentials.rows].find((c) => c.id === openCredentialId) ?? null;
  const runtimes = credentials.rows;

  return (
    <PageContainer>
      <PageHeader title="Members" subtitle="Who is a member of this server, who has been invited, and which runtimes write here. Everything is open to every member, and every change names who made it." />
      <PageLoading isLoading={members.isPending} error={members.error ?? invitations.error ?? credentials.error ?? runCredentials.error}>
        <div className="flex flex-col gap-4">
          <Panel padded title="Members" actions={<button type="button" className={primary} onClick={() => { setInvited(null); setInviteError(null); setInviteFor(''); setInviteOpen(true); }}>Invite</button>}>
            <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Members">
              {list.map((m) => (
                <li key={m.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                  <StatusDot tone={m.revokedAt !== null ? 'outline' : m.linked ? 'sage' : 'ochre'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-on-surface">{m.label ?? m.id}{isMe(m.id) && <span className="ml-2 font-mono text-[10px] uppercase text-on-surface-variant">you</span>}{m.role === 'admin' && <span className="ml-2 font-mono text-[10px] uppercase text-on-surface-variant">admin</span>}</div>
                    <div className="font-mono text-[11px] text-on-surface-variant">{m.id}</div>
                  </div>
                  <span className="text-xs text-on-surface-variant">{m.revokedAt !== null ? `removed ${formatRelative(m.revokedAt)}${nameOf(m.revokedBy) ? ` by ${nameOf(m.revokedBy)}` : ''}` : m.linked ? 'account connected' : 'no account yet'}</span>
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
                      <div className="text-xs text-on-surface-variant">{nameOf(i.createdBy) ? `by ${nameOf(i.createdBy)} · ` : ''}{invitationExpiry(i.expiresAt, Date.now())}</div>
                    </div>
                    <button type="button" className={button} onClick={() => { setWithdrawError(null); actions.revokeInvitation.mutate(i.id, { onError: (err) => setWithdrawError(refusalText(err)) }); }}>Withdraw</button>
                  </li>
                ))}
              </ul>
            )}
            {withdrawError && <p className="mt-2 font-sans text-xs text-tertiary">{withdrawError}</p>}
          </Panel>

          <Panel padded title="Runtimes">
            <p className="mb-2 font-sans text-xs text-on-surface-variant">
              One machine, one runtime. What each is allowed to do, and what this server last heard from it. Select one to see what it wrote.
            </p>
            <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Runtimes">
              {runtimes.map((c) => (
                <RuntimeRow
                  key={c.id}
                  credential={c}
                  memberName={nameOf(c.memberId)}
                  revokedByName={nameOf(c.revokedBy)}
                  lookup={workerFor(fleet, c.id)}
                  onOpen={() => setOpenCredentialId(c.id)}
                  onStop={() => { setStopError(null); setRevokeCredentialId(c.id); }}
                />
              ))}
            </ul>
            {runtimes.length === 0 && !credentials.isPending && <p className="font-sans text-sm text-on-surface-variant">No runtime has joined yet.</p>}
            {credentials.hasMore && <button type="button" className={`${button} mt-3`} onClick={credentials.more}>Show more</button>}
            {runCredentials.rows.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer font-sans text-xs text-on-surface-variant">Run credentials</summary>
                <p className="mt-1 font-sans text-xs text-on-surface-variant">
                  One per agent run, stopped when its run ends. These belong to runs, not to machines.
                </p>
                <ul className="mt-1 flex flex-col divide-y divide-outline-variant/10" aria-label="Run credentials">
                  {runCredentials.rows.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                      <StatusDot tone={c.live ? 'ochre' : 'outline'} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpenCredentialId(c.id)}>
                        <div className="font-mono text-[11px] text-on-surface-variant">{c.id} · started {formatRelative(c.lineageStartedAt)}</div>
                      </button>
                      <span className="text-xs text-on-surface-variant">{credentialWords(c, nameOf(c.revokedBy))}</span>
                      {c.live && <button type="button" className={button} onClick={() => { setStopError(null); setRevokeCredentialId(c.id); }}>Stop</button>}
                    </li>
                  ))}
                </ul>
                {runCredentials.hasMore && <button type="button" className={`${button} mt-2`} onClick={runCredentials.more}>Show more</button>}
              </details>
            )}
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
        errorMessage={stopError}
        onConfirm={() => {
          if (revokeCredentialId === null) return;
          actions.revokeCredential.mutate(revokeCredentialId, { onSuccess: () => setRevokeCredentialId(null), onError: (err) => setStopError(refusalText(err)) });
        }}
      />

      <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) { setInvited(null); actions.mintInvitation.reset(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{invited ? 'Invitation ready' : 'Invite'}</DialogTitle>
            <DialogDescription>{invited ? 'Give this key to the person joining. It works once and expires on its own.' : 'An invitation joins a new member, or adds another runtime to a member already here.'}</DialogDescription>
          </DialogHeader>
          {invited ? (
            <KeyReveal label="Invitation key" value={invited.key} hint={`Expires ${formatDateTime(invited.expiresAt)}. The person joining exchanges it for their own credential when they set up; until then, keep it private.`} />
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

      <SlideoutDetailPanel open={openCredential !== null} onClose={() => setOpenCredentialId(null)} ariaLabel="Runtime activity">
        {openCredential && <CredentialActivity credential={openCredential} memberName={nameOf(openCredential.memberId) ?? openCredential.memberId} />}
      </SlideoutDetailPanel>
    </PageContainer>
  );
}

/** One machine's runtime: what its credential allows, and what this server last heard from it as a worker. */
function RuntimeRow({ credential, memberName, revokedByName, lookup, onOpen, onStop }: {
  credential: CredentialRow;
  memberName: string | null;
  revokedByName: string | null;
  lookup: FleetLookup;
  onOpen: () => void;
  onStop: () => void;
}) {
  const state = lookup.known ? workerState(lookup.worker, Date.now()) : null;
  return (
    <li className="flex flex-col gap-1 py-2 font-sans text-sm">
      <div className="flex items-center gap-3">
        <StatusDot tone={state?.tone ?? (credential.live ? 'sage' : 'outline')} />
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <div className="text-on-surface">{credential.machineId ?? credential.id}{memberName === null ? '' : <span className="text-xs text-on-surface-variant"> · {memberName}</span>}</div>
          <div className="font-mono text-[11px] text-on-surface-variant">{credential.id} · started {formatRelative(credential.lineageStartedAt)}</div>
        </button>
        <span className="text-xs text-on-surface-variant">{credentialWords(credential, revokedByName)}</span>
        {credential.live && <button type="button" className={button} onClick={onStop}>Stop</button>}
      </div>
      {lookup.known ? (
        <>
          <p className="pl-5 font-sans text-xs text-on-surface-variant">{state!.line}</p>
          <p className="pl-5 font-sans text-xs text-on-surface-variant">{offersWords(lookup.worker)}</p>
          {lookup.worker.busy === null && lookup.worker.lastReason !== null && lookup.worker.lastSeenAt > 0 && (
            <p className="pl-5 font-sans text-xs text-on-surface-variant">
              Last claim: {REASON_WORDS[lookup.worker.lastReason]}. That is what this worker's last poll found, not what every worker can run.
            </p>
          )}
        </>
      ) : (
        <p className="pl-5 font-sans text-xs text-on-surface-variant">{FLEET_UNKNOWN_WORDS[lookup.why]}</p>
      )}
    </li>
  );
}

function CredentialActivity({ credential, memberName }: { credential: CredentialRow; memberName: string }) {
  const activity = usePaged<ActivityRow>(['credential-activity', credential.id], `/api/credentials/${encodeURIComponent(credential.id)}/activity?limit=50`);
  const projects = useProjects();
  const projectName = (id: string) => projects.data?.projects.find((p) => p.projectId === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <div className="font-serif text-lg text-on-surface">{credential.machineId ?? credential.id}</div>
        <div className="font-sans text-xs text-on-surface-variant">{memberName} · {credentialWords(credential, null)} · {(credential.bytesWritten / 1_048_576).toFixed(1)} MB written</div>
      </div>
      <PageLoading isLoading={activity.isPending} error={activity.error}>
        {activity.rows.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant">Nothing written yet.</p>
        ) : (
          <table className="w-full font-sans text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wide text-on-surface-variant"><tr><th>When</th><th>Project</th><th>What</th><th>Session</th></tr></thead>
            <tbody>
              {activity.rows.map((a) => (
                <tr key={a.eventId} className="border-t border-outline-variant/10">
                  <td className="py-1 text-on-surface-variant">{formatRelative(a.createdAt)}</td>
                  <td className="py-1 text-on-surface">{projectName(a.projectId)}</td>
                  <td className="py-1 text-on-surface-variant">{KIND_LABEL[a.kind] ?? a.kind}</td>
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
