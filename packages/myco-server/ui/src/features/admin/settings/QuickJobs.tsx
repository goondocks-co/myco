import { useState } from 'react';
import type { QuickJobs as QuickJobsFact, QuickJobsAnswerer } from '@goondocks/myco-shared/settings-contract';
import { Button, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSecrets, useSettingsActions } from '../../../hooks/use-settings';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { LeafGroup } from './catalogue';
import { KeyDialog } from './KeyDialog';
import { LeafControl } from './LeafControl';
import type { LeafRow } from './wire';

/** The key quick jobs send to an address of your own. */
const ADDRESS_KEY = 'single-turn';

/** Each answerer as the choice names it, and what it costs and needs. */
const ANSWERERS: Readonly<Record<QuickJobsAnswerer, { label: string; help: string }>> = {
  included: {
    label: 'Cloudflare (included)',
    help: 'Cloudflare’s built-in model answers. Included with your Cloudflare account; no key or runner needed.',
  },
  address: {
    label: 'My own model address',
    help: 'A model you run or rent, such as LM Studio or OpenRouter, answers. It costs what that service charges. It needs the address, the model name, and a key if the service asks for one.',
  },
  runner: {
    label: 'A runner’s agent',
    help: 'The agent that does the rest of Myco’s work answers, on a runner. Slower, and each title is a run billed like any other agent work. It needs a ready runner.',
  },
};

/**
 * Quick jobs: who answers session titles and summaries. One choice among the answerers this server offers; the words
 * under it say what that choice costs and needs, and the fields only an address uses appear only for it. The server
 * says who answers now; a choice of an address takes effect once its address and model are saved.
 */
export function QuickJobs({ group, rows, fact }: { group: LeafGroup; rows: ReadonlyMap<string, LeafRow>; fact: QuickJobsFact }) {
  const admin = useIsAdmin();
  const actions = useSettingsActions();
  const secrets = useSecrets();
  const [chosen, setChosen] = useState<QuickJobsAnswerer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const shown = chosen ?? fact.answeredBy;
  const pending = actions.clearQuickJobsAddress.isPending;
  const key = secrets.data?.secrets.find((secret) => secret.name === ADDRESS_KEY);

  /** Removes the address and its model in one write, so the server's own answerer takes quick jobs. */
  const choose = (next: QuickJobsAnswerer) => {
    setError(null);
    setChosen(next);
    if (next === 'address' || group.leaves.every((field) => rows.get(field.leaf)?.configured !== true)) return;
    actions.clearQuickJobsAddress.mutate({ leaves: group.leaves.map((field) => field.leaf) }, {
      onSuccess: () => setChosen(null),
      onError: (failure) => { setChosen(null); setError(settingsRefusalText(failure)); },
    });
  };

  const status = error ?? (shown !== fact.answeredBy
    ? `${ANSWERERS[fact.answeredBy].label} still answers until the address and model are saved.`
    : undefined);
  return (
    <AdminSection id={group.id} title={group.label} description={group.note}>
      <RowCard label={group.label}>
        <SettingRow
          setting="quick-jobs"
          label="Answered by"
          htmlFor="quick-jobs-answerer"
          note={<span data-quick-jobs-help={shown}>{ANSWERERS[shown].help}</span>}
          status={status}
          refused={error !== null}
          control={(
            <Select
              id="quick-jobs-answerer"
              label="Answered by"
              value={shown}
              disabled={!admin || pending}
              options={fact.offered.map((answerer) => ({ value: answerer, label: ANSWERERS[answerer].label }))}
              onValueChange={(value) => choose(value as QuickJobsAnswerer)}
            />
          )}
        />
        {shown === 'address' && <>
          {group.leaves.map((field) => <LeafControl key={field.leaf} field={field} row={rows.get(field.leaf)} />)}
          <SettingRow
            setting="quick-jobs-key"
            label="Key"
            note="Only if the address asks for one. It is sent only to that address."
            status={key?.configured === true ? (key.readable ? `Stored · ${key.maskedValue ?? 'set'}` : 'Stored under a key this server can no longer open. Enter it again.') : 'None stored'}
            control={admin ? <Button size="sm" onClick={() => setKeyOpen(true)}>{key?.configured === true ? 'Replace key' : 'Add key'}</Button> : undefined}
          />
        </>}
      </RowCard>
      <KeyDialog name={keyOpen ? ADDRESS_KEY : null} replacing={key?.configured === true} onClose={() => setKeyOpen(false)} />
    </AdminSection>
  );
}
