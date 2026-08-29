import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { StatusDot } from '../components/ui/status-dot';
import { KeyReveal } from '../components/access/KeyReveal';
import { useAccessActions, useGrants, useMembers, type GrantRow } from '../hooks/use-access';
import { formatRelative } from '../lib/format';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90';

/** `/p/:projectId/access`: the external agents that may read this project. */
export function ProjectAccess() {
  const { projectId = '' } = useParams();
  const grants = useGrants(projectId);
  const members = useMembers();
  const actions = useAccessActions();
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<{ title: string; key: string } | null>(null);
  const [rotating, setRotating] = useState<GrantRow | null>(null);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const nameOf = (id: string) => members.data?.members.find((m) => m.id === id)?.label ?? id;
  const list = grants.data?.grants ?? [];

  return (
    <PageContainer>
      <PageHeader title="Access" subtitle="External agents that may read this project. They see the project's memory and nothing else; they never write." />
      <PageLoading isLoading={grants.isPending} error={grants.error}>
        <Panel padded title="External agents" actions={<button type="button" className={primary} onClick={() => { setLabel(''); setRevealed(null); setAddOpen(true); }}>Add external agent</button>}>
          {list.length === 0 ? (
            <p className="font-sans text-sm text-on-surface-variant">No external agents yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="External agents">
              {list.map((g) => (
                <li key={g.id} className="flex items-center gap-3 py-2 font-sans text-sm">
                  <StatusDot tone={g.revokedAt !== null ? 'outline' : g.lastUsedAt === null ? 'ochre' : 'sage'} />
                  <div className="min-w-0 flex-1">
                    <div className="text-on-surface">{g.label ?? g.id}</div>
                    <div className="text-xs text-on-surface-variant">
                      added {formatRelative(g.createdAt)} by {nameOf(g.createdBy)} · {g.revokedAt !== null ? `ended by ${nameOf(g.revokedBy ?? '')}${g.rotatedTo ? ' (rotated)' : ''}` : g.lastUsedAt === null ? 'never used' : `last used ${formatRelative(g.lastUsedAt)}`}
                    </div>
                  </div>
                  {g.revokedAt === null && (
                    <>
                      <button type="button" className={button} onClick={() => setRotating(g)}>Rotate</button>
                      <button type="button" className={button} onClick={() => setRevoking(g)}>Revoke</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </PageLoading>

      <Dialog open={addOpen} onOpenChange={(open) => { setAddOpen(open); if (!open) setRevealed(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revealed ? revealed.title : 'Add an external agent'}</DialogTitle>
            <DialogDescription>{revealed ? 'Put this key where the agent reads its configuration. It is not shown again.' : 'A name for the agent, so its access is recognisable later.'}</DialogDescription>
          </DialogHeader>
          {revealed ? (
            <KeyReveal label="Access key" value={revealed.key} hint="Read-only, for this project only. Rotate or revoke it here at any time." />
          ) : (
            <form className="flex flex-col gap-3" onSubmit={(e) => {
              e.preventDefault();
              actions.mintGrant.mutate({ projectId, ...(label.trim() === '' ? {} : { label: label.trim() }) }, { onSuccess: (r) => setRevealed({ title: 'Access key ready', key: r.key }) });
            }}>
              <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
                Name
                <input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="review bot" className="rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1.5 text-sm text-on-surface" />
              </label>
              <button type="submit" className={primary} disabled={actions.mintGrant.isPending}>Create key</button>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => { if (!open) setRotating(null); }}
        title={`Rotate ${rotating?.label ?? rotating?.id ?? ''}?`}
        description="The current key stops working the moment the new one exists. You will see the new key once."
        confirmLabel="Rotate"
        variant="destructive"
        isPending={actions.rotateGrant.isPending}
        onConfirm={() => {
          if (!rotating) return;
          actions.rotateGrant.mutate({ projectId, grantId: rotating.id }, { onSuccess: (r) => { setRotating(null); setRevealed({ title: 'New access key', key: r.key }); setAddOpen(true); } });
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={`Revoke ${revoking?.label ?? revoking?.id ?? ''}?`}
        description="The agent loses access at once. Nothing it read is affected."
        confirmLabel="Revoke"
        isPending={actions.revokeGrant.isPending}
        onConfirm={() => {
          if (!revoking) return;
          actions.revokeGrant.mutate({ projectId, grantId: revoking.id }, { onSuccess: () => setRevoking(null) });
        }}
      />
    </PageContainer>
  );
}
