import { useState } from 'react';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { SECRET_SLOTS, slotUse } from '@goondocks/myco-shared/secret-slots';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Disclosure, ErrorState, Input, LoadingState, MoreMenu } from '../../../design';
import { settingsRefusalText, useSecrets, useSettingsActions } from '../../../hooks/use-settings';
import { harnessLabel } from '../../../lib/harness';
import { ago } from '../../today/words';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { SecretRow } from './wire';

/** The keys' anchor on Models and keys, where an older `?tab=secrets` link lands. */
export const CREDENTIALS_ANCHOR = 'credentials';

const LABEL: Readonly<Record<string, string>> = Object.fromEntries(SECRET_SLOTS.map((slot) => [slot.name, slot.label]));
const USE: Readonly<Record<string, string>> = Object.fromEntries(SECRET_SLOTS.map((slot) => [slot.name, slotUse(slot, harnessLabel)]));
const labelOf = (name: string): string => LABEL[name] ?? name;

/** Where a key stands, in words: its masked form and who stored it when, or that none is stored. Never the key. */
function keyStatus(secret: SecretRow, name: string | null, now: number): string {
  if (!secret.configured) return 'Not set';
  if (!secret.readable) return 'Stored under a key this server can no longer open. Enter it again.';
  const stored = `Stored · ${secret.maskedValue ?? 'set'}`;
  const when = secret.updatedAt === null ? '' : ` ${ago(secret.updatedAt, now)}`;
  return name === null ? `${stored} · saved${when}` : `${stored} · saved by ${name}${when}`;
}

/**
 * The provider keys this server holds: stored once, shown masked and never
 * sent back. Each says what reads it; one is set or replaced in a dialog, and
 * removed from its menu behind a confirm.
 */
export function Credentials() {
  const keyPermission = permissionOf(useMe().data, 'keys');
  const secrets = useSecrets();
  const actions = useSettingsActions();
  const nameOf = useMemberNames();
  const [editing, setEditing] = useState<SecretRow | null>(null);
  const [removing, setRemoving] = useState<SecretRow | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  // Closing forgets the typed key and the mutation that carried it.
  const close = () => { setEditing(null); setDraft(''); setError(null); actions.setSecret.reset(); };
  const closeRemove = () => { setRemoving(null); actions.deleteSecret.reset(); };

  return (
    <AdminSection
      id={CREDENTIALS_ANCHOR}
      title="Keys"
      description="Stored once, shown masked, never sent back. Each key is used only for what its row says, and work bills to whichever account the key belongs to."
    >
      {!keyPermission.allowed && <p className="t-small text-muted">{keyPermission.reason ?? 'Only an admin can manage keys.'}</p>}
      {secrets.isPending ? <LoadingState label="Loading keys" count={3} />
        : secrets.isError ? <ErrorState error={secrets.error} onRetry={() => void secrets.refetch()} />
        : (
          <>
          <RowCard label="Keys">
            {secrets.data.secrets.filter((secret) => !secret.retired).map((secret) => (
              <SettingRow
                key={secret.name}
                setting={`secret.${secret.name}`}
                label={labelOf(secret.name)}
                note={USE[secret.name]}
                status={keyStatus(secret, nameOf(secret.updatedBy), now)}
                control={(
                  <>
                    <Button size="sm" disabled={!keyPermission.allowed} onClick={() => { setDraft(''); setError(null); setEditing(secret); }}>
                      {secret.configured ? 'Replace' : 'Set'}
                    </Button>
                    {secret.configured && (
                      <MoreMenu
                        label={`More for the ${labelOf(secret.name)} key`}
                        items={[{ label: 'Remove key', tone: 'danger', disabled: !keyPermission.allowed, onSelect: () => setRemoving(secret) }]}
                      />
                    )}
                  </>
                )}
              />
            ))}
          </RowCard>
          {secrets.data.secrets.some((secret) => secret.retired && secret.configured) && (
            <Disclosure summary="Older keys">
              <RowCard label="Older keys">
                {secrets.data.secrets.filter((secret) => secret.retired && secret.configured).map((secret) => (
                  <SettingRow
                    key={secret.name}
                    setting={`secret.${secret.name}`}
                    label={labelOf(secret.name)}
                    note="Nothing on this server reads this key any more."
                    status={keyStatus(secret, nameOf(secret.updatedBy), now)}
                    control={null}
                  />
                ))}
              </RowCard>
            </Disclosure>
          )}
          </>
        )}

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent
          title={editing === null ? '' : `${editing.configured ? 'Replace' : 'Set'} the ${labelOf(editing.name)} key`}
          description="The key is stored and never shown again. Work that uses it bills to the account it belongs to."
        >
          <form
            className="flex flex-col gap-s3"
            onSubmit={(e) => {
              e.preventDefault();
              if (editing === null || draft.length === 0) return;
              setError(null);
              actions.setSecret.mutate({ name: editing.name, value: draft }, { onSuccess: close, onError: (err) => setError(settingsRefusalText(err)) });
            }}
          >
            <Input type="password" autoComplete="off" aria-label="Key" value={draft} onChange={(e) => setDraft(e.target.value)} />
            {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
            <DialogFooter>
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={draft.length === 0} pending={actions.setSecret.isPending}>Save key</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) closeRemove(); }}
        title={`Remove the ${removing === null ? '' : labelOf(removing.name)} key?`}
        description="Anything that uses this key stops working until a new one is stored."
        confirmLabel="Remove key"
        pending={actions.deleteSecret.isPending}
        error={actions.deleteSecret.error ? settingsRefusalText(actions.deleteSecret.error) : null}
        onConfirm={() => { if (removing !== null) actions.deleteSecret.mutate({ name: removing.name }, { onSuccess: closeRemove }); }}
      />
    </AdminSection>
  );
}
