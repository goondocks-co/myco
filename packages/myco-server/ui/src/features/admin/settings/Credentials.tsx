import { useState } from 'react';
import { HARNESS_CREDENTIALS, type HarnessCredentialKind } from '@goondocks/myco-shared/harness-providers';
import { harnessesReading, SECRET_SLOTS, slotUse, type SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import type { EmbeddingChoices, QuickJobs } from '@goondocks/myco-shared/settings-contract';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Button, ConfirmDialog } from '../../../design';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import type { AgentPayersAnswer } from '../../../hooks/use-fleet';
import { harnessLabel } from '../../../lib/harness';
import { useMemberNames } from '../members';
import { ConnectionRow } from './ConnectionRow';
import { KeyDialog, keyLabel } from './KeyDialog';
import type { SecretRow } from './wire';

/** Where an older link to the provider keys lands on Connections: before the first key, whether or not one is stored. */
export const CREDENTIALS_ANCHOR = 'credentials';

const USE: Readonly<Record<string, string>> = Object.fromEntries(SECRET_SLOTS.map((slot) => [slot.name, slotUse(slot, harnessLabel)]));

const KIND_WORDS: Readonly<Record<HarnessCredentialKind, string>> = {
  subscription: 'Subscription token: draws on that subscription.',
  'api-key': 'API key: billed to the API account, including any monthly credit.',
};

/** The kinds of key the agents reading a slot can use. */
const acceptedKinds = (name: string): HarnessCredentialKind[] =>
  [...new Set(harnessesReading(name as SecretSlotName).flatMap((agent): readonly HarnessCredentialKind[] => HARNESS_CREDENTIALS[agent]?.accepts ?? ['api-key']))];

/**
 * What kind of key is stored, where the agents reading it can tell kinds apart, or that none of them can use this kind.
 * Null where the kind changes nothing.
 */
export function keyKindWords(name: string, kind: HarnessCredentialKind | null): string | null {
  const accepted = acceptedKinds(name);
  if (kind === null || accepted.length === 0) return null;
  if (!accepted.includes(kind)) return `${kind === 'subscription' ? 'Subscription token' : 'API key'}: ${harnessesReading(name as SecretSlotName).map(harnessLabel).join(' and ')} can’t use this kind of key.`;
  return accepted.length > 1 ? KIND_WORDS[kind] : null;
}

/** What a stored key is in use for now: the runners that chose it for an agent reading it, quick jobs, and search. */
export interface KeyUses { payers: AgentPayersAnswer['agents']; quickJobs: QuickJobs | null; embedding: EmbeddingChoices | null }

export function keyUsedBy(name: string, uses: KeyUses): string[] {
  const agents = harnessesReading(name as SecretSlotName);
  const runners = uses.payers.filter((entry) => agents.includes(entry.agent)).flatMap((entry) =>
    entry.runners.filter((runner) => runner.choice === 'stored').map((runner) => `${runner.name} (${harnessLabel(entry.agent)})`));
  const searchProvider = uses.embedding?.selection === null || uses.embedding === null ? null
    : uses.embedding.providers.find((provider) => provider.id === uses.embedding!.selection!.provider) ?? null;
  return [
    ...runners,
    ...(name === 'single-turn' && uses.quickJobs?.answeredBy === 'address' ? ['quick jobs'] : []),
    ...(searchProvider?.credential === name ? ['search by meaning'] : []),
  ];
}

/** Where a stored key stands: its masked form, who saved it when, and whether anything uses it now. */
function keyStatus(secret: SecretRow, usedBy: readonly string[]): { words: string; tone: 'ok' | 'bad' | 'neutral' } {
  if (!secret.readable) return { words: 'Enter it again', tone: 'bad' };
  return usedBy.length > 0 ? { words: 'In use', tone: 'ok' } : { words: 'Not in use', tone: 'neutral' };
}

/**
 * One row per key this server stores: what it is for, its kind, whether anything uses it now, and Replace and Remove.
 * The key itself is never shown, only its first and last characters.
 */
export function KeyRows({ secrets, uses }: { secrets: readonly SecretRow[]; uses: KeyUses }) {
  const allowed = permissionOf(useMe().data, 'keys').allowed;
  const actions = useSettingsActions();
  const nameOf = useMemberNames();
  const [replacing, setReplacing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SecretRow | null>(null);
  const closeRemove = () => { setRemoving(null); actions.deleteSecret.reset(); };
  const now = Date.now();
  const stored = secrets.filter((secret) => secret.configured);
  return (
    <>
      {stored.map((secret) => {
        const usedBy = keyUsedBy(secret.name, uses);
        const who = nameOf(secret.updatedBy);
        const saved = secret.updatedAt === null ? 'saved' : `saved ${who === null ? '' : `by ${who} `}${agoWords(secret.updatedAt, now)}`;
        const kind = keyKindWords(secret.name, secret.kind);
        return (
          <ConnectionRow
            key={secret.name}
            kind="key"
            label={keyLabel(secret.name)}
            use={USE[secret.name] ?? 'Nothing on this server reads it.'}
            status={keyStatus(secret, usedBy)}
            note={<>
              <p className="t-mono">{secret.readable ? `${secret.maskedValue ?? 'Stored'} · ${saved}` : 'Stored under a key this server can no longer open. Enter it again.'}</p>
              {kind !== null && <p data-key-kind={secret.kind}>{kind}</p>}
              {usedBy.length > 0 && <p>{`Used by ${usedBy.join(', ')}.`}</p>}
            </>}
            actions={allowed && <>
              <Button size="sm" onClick={() => setReplacing(secret.name)}>Replace</Button>
              <Button size="sm" variant="ghost" onClick={() => setRemoving(secret)}>Remove</Button>
            </>}
          />
        );
      })}
      <KeyDialog name={replacing} replacing onClose={() => setReplacing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) closeRemove(); }}
        title={`Remove the ${removing === null ? '' : keyLabel(removing.name)}?`}
        description="Anything that uses this key stops working until a new one is stored. Work that chose it waits; it never falls back to another sign-in."
        confirmLabel="Remove key"
        pending={actions.deleteSecret.isPending}
        error={actions.deleteSecret.error ? settingsRefusalText(actions.deleteSecret.error) : null}
        onConfirm={() => { if (removing !== null) actions.deleteSecret.mutate({ name: removing.name }, { onSuccess: closeRemove }); }}
      />
    </>
  );
}
