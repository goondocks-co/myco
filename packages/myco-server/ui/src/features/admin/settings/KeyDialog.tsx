import { useState } from 'react';
import { SECRET_SLOTS } from '@goondocks/myco-shared/secret-slots';
import { Button, Dialog, DialogContent, DialogFooter, Input } from '../../../design';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';

const LABEL: Readonly<Record<string, string>> = Object.fromEntries(SECRET_SLOTS.map((slot) => [slot.name, slot.label]));

/** A key's name as a row shows it: the account it belongs to. */
export const keyLabel = (name: string): string => `${LABEL[name] ?? name} key`;

/**
 * The field that stores one key: typed once, saved, and never shown again. The typed key and the mutation that
 * carried it are forgotten once it is saved or the form closes.
 */
export function KeyForm({ name, onDone, onCancel }: { name: string; onDone: () => void; onCancel: () => void }) {
  const actions = useSettingsActions();
  const allowed = permissionOf(useMe().data, 'keys');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = (then: () => void) => { setDraft(''); setError(null); actions.setSecret.reset(); then(); };
  return (
    <form
      className="flex flex-col gap-s3"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.length === 0 || !allowed.allowed) return;
        setError(null);
        actions.setSecret.mutate({ name, value: draft }, { onSuccess: () => close(onDone), onError: (err) => setError(settingsRefusalText(err)) });
      }}
    >
      <Input type="password" autoComplete="off" aria-label={keyLabel(name)} value={draft} onChange={(e) => setDraft(e.target.value)} />
      {!allowed.allowed && <p className="t-small text-muted">{allowed.reason ?? 'Only an admin can store keys.'}</p>}
      {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={() => close(onCancel)}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={draft.length === 0 || !allowed.allowed} pending={actions.setSecret.isPending}>Save key</Button>
      </DialogFooter>
    </form>
  );
}

/** Stores or replaces one key in a dialog. `name` null keeps it closed. */
export function KeyDialog({ name, replacing, onClose }: { name: string | null; replacing: boolean; onClose: () => void }) {
  return (
    <Dialog open={name !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        title={name === null ? '' : `${replacing ? 'Replace' : 'Add'} the ${keyLabel(name)}`}
        description="The key is stored and never shown again. Work that uses it bills to the account it belongs to."
      >
        {name !== null && <KeyForm name={name} onDone={onClose} onCancel={onClose} />}
      </DialogContent>
    </Dialog>
  );
}
