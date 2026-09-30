import { useState } from 'react';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Button, CommandBlock, Dialog, DialogContent, DialogFooter, Select } from '../../../design';
import { refusalText, useAccessActions } from '../../../hooks/use-access';
import { formatDateTime } from '../../../lib/format';
import { DEFAULT_VALIDITY, loginCommand, VALIDITY_OPTIONS } from './words';

/** What the dialog makes: an invitation for a new member, or a machine for a member already here. */
export type InviteKind = 'invite' | 'machine';

export interface InviteTarget {
  kind: InviteKind;
  /** For a machine: the member picked when the dialog opens. */
  memberId?: string;
}

export interface InviteDialogProps {
  /** What the dialog is open for, or null while it is closed. */
  target: InviteTarget | null;
  onClose: () => void;
  /** The people a machine can be added for, by name. */
  people: ReadonlyArray<{ id: string; name: string }>;
}

const WORDS: Record<InviteKind, { title: string; description: string; caption: string; create: string }> = {
  invite: {
    title: INVITE_CONTROLS.invite,
    description: 'Creates a one-time link for someone new. Whoever runs it joins this server as a member, with the machine they run it on.',
    caption: 'On their machine, run:',
    create: 'Create invitation',
  },
  machine: {
    title: INVITE_CONTROLS.button,
    description: 'Creates a one-time link that signs a machine in for a member already here, including a machine of theirs whose sign-in ended.',
    caption: 'On the machine you want to add, run:',
    create: 'Create link',
  },
};

/**
 * Invite a teammate, or add a machine for a member: pick how long the link
 * works (and, for a machine, whose it is), then the exact command to run with
 * it. The key is shown this once and kept only in the dialog's own state.
 */
export function InviteDialog({ target, onClose, people }: InviteDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target !== null && <InviteBody key={`${target.kind}:${target.memberId ?? ''}`} target={target} people={people} onClose={onClose} />}
    </Dialog>
  );
}

function InviteBody({ target, people, onClose }: { target: InviteTarget; people: InviteDialogProps['people']; onClose: () => void }) {
  const mint = useAccessActions().mintInvitation;
  const [validity, setValidity] = useState<string>(DEFAULT_VALIDITY);
  const [memberId, setMemberId] = useState<string>(target.memberId ?? people[0]?.id ?? '');
  const [minted, setMinted] = useState<{ key: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = WORDS[target.kind];
  const forMember = target.kind === 'machine';

  const create = () => {
    setError(null);
    const ttlMinutes = Number(validity);
    mint.mutate(forMember ? { memberId, ttlMinutes } : { ttlMinutes }, {
      onSuccess: (answer) => setMinted({ key: answer.key, expiresAt: answer.expiresAt }),
      onError: (err) => setError(refusalText(err)),
    });
  };

  if (minted !== null) {
    return (
      <DialogContent title={words.title} description={words.description}>
        <CommandBlock caption={words.caption} command={loginCommand(minted.key)} />
        <p className="t-small text-muted" data-invite-note="">
          It works once, until {formatDateTime(minted.expiresAt)}, and is shown only now: keep it private until it has been used.
        </p>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent title={words.title} description={words.description}>
      <form className="flex flex-col gap-s4" onSubmit={(event) => { event.preventDefault(); if (!mint.isPending) create(); }}>
        {forMember && (
          <div className="flex flex-col gap-s2">
            <span className="t-small font-medium text-ink-2" aria-hidden>{INVITE_CONTROLS.field}</span>
            <Select
              label={INVITE_CONTROLS.field}
              value={memberId}
              onValueChange={setMemberId}
              options={people.map((person) => ({ value: person.id, label: person.name }))}
            />
          </div>
        )}
        <div className="flex flex-col gap-s2">
          <span className="t-small font-medium text-ink-2" aria-hidden>The link works</span>
          <Select label="How long the link works" value={validity} onValueChange={setValidity} options={VALIDITY_OPTIONS} />
        </div>
        {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" pending={mint.isPending} disabled={forMember && memberId === ''}>{words.create}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
