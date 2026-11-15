import { useState } from 'react';
import { dateTimeWords } from '@goondocks/myco-shared/time-words';
import { Button, ConfirmDialog, Textarea } from '../../design';
import { useMembers } from '../../hooks/use-access';
import { useChangeSpore, type SporeChange } from '../../hooks/use-knowledge';
import { ApiError } from '../../lib/api';
import type { SporeArticleAnswer, SporeResolutionFields } from './wire';
import { authorName, DEFAULT_SPORE_STATUS, RETIRED_SPORE_STATUS } from './words';

/** Who made a change of status, as the reader names them: a member by name, Myco's run, an access key, or no one named. */
function changedBy(verb: 'Retired' | 'Restored', change: SporeResolutionFields, members: ReadonlyArray<{ id: string; label: string | null }> | undefined): string {
  switch (change.authorKind) {
    case 'member': return `${verb} by ${(change.author === null ? null : authorName(change.author, members)) ?? 'a member'}`;
    case 'run': return `${verb} by Myco in one of its runs`;
    case 'grant': return `${verb} with an access key`;
    default: return verb;
  }
}

/** A retired spore says so first: who retired it, when, and why. */
export function RetiredNote({ change, now }: { change: SporeResolutionFields | null; now: number }) {
  const members = useMembers();
  const retired = change !== null && change.action === RETIRED_SPORE_STATUS;
  return (
    <div role="note" className="flex flex-col gap-s1 rounded-card border border-line bg-surface-2 px-s4 py-s3" data-spore-retired="">
      <p className="t-small font-medium text-ink">
        {retired ? `${changedBy('Retired', change, members.data?.members)}, ${dateTimeWords(change.createdAt, now)}.` : 'This spore was retired.'}
      </p>
      {retired && change.reason !== null && change.reason.trim() !== '' && <p className="t-small text-ink-2" data-spore-retired-reason="">Why: {change.reason}</p>}
    </div>
  );
}

/** Who restored a current spore and when, for its facts; null when its newest change was not a restore. */
export function useRestoredWords(change: SporeResolutionFields | null, now: number): string | null {
  const members = useMembers();
  if (change === null || change.action !== 'restore') return null;
  return `${changedBy('Restored', change, members.data?.members)}, ${dateTimeWords(change.createdAt, now)}`;
}

/** Why a change was refused, in the reader's words. */
function refusalWords(error: Error | null, retiring: boolean): string | null {
  if (error === null) return null;
  if (error instanceof ApiError && error.code === 'spore_changed') return 'This spore changed after the page showed it, and nothing was changed. Reload the page and try again.';
  if (error instanceof ApiError && error.code === 'spore_replaced') return 'This spore was replaced, so it can’t be restored, and nothing was changed.';
  return retiring ? 'The spore couldn’t be retired. Try again.' : 'The spore couldn’t be restored. Try again.';
}

/**
 * An admin's control over a spore's status: retire a current spore, with the reason it no longer holds, or restore one retired
 * with nothing in its place. Each passes through a confirmation, retiring only once a reason is written, and is made at the
 * revision the page shows. A replaced or merged spore offers neither: it leads to what replaced it.
 */
export function SporeStatusControl({ projectId, answer }: { projectId: string; answer: SporeArticleAnswer }) {
  const { spore } = answer;
  const change = useChangeSpore(projectId, spore.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const retiring = spore.status === DEFAULT_SPORE_STATUS;
  if (!retiring && spore.status !== RETIRED_SPORE_STATUS) return null;
  const done = () => { setOpen(false); setReason(''); change.reset(); };
  const ask = (): SporeChange | null => {
    if (!retiring) return { action: 'restore', revision: spore.revision };
    const why = reason.trim();
    return why === '' ? null : { action: 'retire', reason: why, revision: spore.revision };
  };
  const submit = () => {
    const request = ask();
    if (change.isPending || request === null) return;
    change.mutate(request, { onSuccess: () => { setOpen(false); setReason(''); } });
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-spore-change={retiring ? 'retire' : 'restore'}>
        {retiring ? 'Retire' : 'Restore'}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => { if (!next && !change.isPending) done(); }}
        title={retiring ? 'Retire this spore?' : 'Restore this spore?'}
        description={retiring
          ? 'Myco stops serving it to your agents and search leaves it out. It stays readable here with your reason, and can be restored.'
          : 'It becomes current again now, and search by words finds it at once. Myco serves it to your agents, and search by meaning finds it, once Myco has indexed it again, usually within a few minutes.'}
        confirmLabel={retiring ? 'Retire' : 'Restore'}
        tone="primary"
        pending={change.isPending}
        confirmDisabled={ask() === null}
        error={refusalWords(change.error, retiring)}
        onConfirm={submit}
      >
        {retiring && (
          <div className="flex flex-col gap-s1">
            <label htmlFor="spore-retire-reason" className="t-small text-muted">Why it no longer holds</label>
            <Textarea id="spore-retire-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
