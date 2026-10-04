import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { embeddingPrice, type EmbeddingChoices, type EmbeddingModelChoice, type EmbeddingProviderId } from '@goondocks/myco-shared/settings-contract';
import { Button, ConfirmDialog, Input, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, switchRefusalText, useSettings, useSettingsActions } from '../../../hooks/use-settings';
import { useNow } from '../../../hooks/use-today';
import { SettingRow } from '../AdminFrame';
import { StoredValue } from '../StoredValue';
import type { LeafField } from './catalogue';
import { EmbeddingSwitchPanel, PassedOverSources, estimateWords, shortModel } from './EmbeddingSwitch';
import type { LeafRow } from './wire';

export { shortModel } from './EmbeddingSwitch';

/** The option that turns semantic search off on a server whose default is none. */
const NONE = '__none__';

/** A model the picker offers to switch search to: chosen, and waiting for the person to confirm the switch. */
interface SwitchOffer { provider: EmbeddingProviderId; label: string; model: string; endpoint?: string }

/** What switching to a model does, in the reader's words, for the offer under the model and its confirmation. */
function offerWords(offer: SwitchOffer, choices: EmbeddingChoices): string {
  const current = choices.selection === null ? null : shortModel(choices.selection.model);
  return `${shortModel(offer.model)} rebuilds search: every source is read again with it, in the background. `
    + (current === null ? 'Search matches words only until it is done.' : `Search keeps working with ${current} meanwhile, and moves to ${shortModel(offer.model)} once every source is done.`);
}

/** What the provider charges for the model per million tokens, where it publishes a price. */
function priceWords(offer: SwitchOffer): string {
  const price = embeddingPrice(offer.provider, offer.model);
  return price === null ? '' : ` ${offer.label} charges $${price} per million tokens.`;
}

const dimensionWords = (dimensions: number | null): string => dimensions === null ? 'size not published' : `${dimensions} dimensions`;

/** One model as the picker lists it: its name, its size, and why it cannot be chosen now, in a word. */
const modelOption = (model: EmbeddingModelChoice, capacity: number) => ({
  value: model.id,
  label: `${model.id} · ${dimensionWords(model.dimensions)}${model.refusal === null ? '' : model.dimensions !== null && model.dimensions > capacity ? ' · too large for search' : ' · rebuilds search'}`,
  short: model.id,
});

/** What search uses now, in words: `Cloudflare Workers AI · bge-m3`, or why it matches words only. */
export function inUseWords(choices: EmbeddingChoices): string {
  const selection = choices.selection;
  if (selection === null) return choices.reason ?? 'Search matches words only.';
  const label = choices.providers.find((p) => p.id === selection.provider)?.label ?? selection.provider;
  const words = `Search uses ${label} with ${shortModel(selection.model)} (${dimensionWords(selection.dimensions)})`;
  return choices.reason === null ? `${words}.` : `${words}. ${choices.reason}`;
}

/** The cache key holding the provider a person has picked and not yet chosen a model for. */
const PENDING_KEY = ['embedding-pending-provider'] as const;

/**
 * The provider a person has picked and not yet chosen a model for, shared by the provider and model rows through the
 * page's query cache. Picking a provider writes nothing: only a model chosen for it does.
 */
function usePendingProvider(): [string | null, (next: string | null) => void] {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: PENDING_KEY, queryFn: () => null as string | null, initialData: null as string | null, staleTime: Infinity, gcTime: Infinity });
  return [data ?? null, (next) => client.setQueryData(PENDING_KEY, next)];
}

/**
 * One row of the embedding picker. Provider, model and endpoint are written together, through one request, only when
 * a model is chosen: picking a provider lists its models and changes nothing. Each row shows what the server resolves
 * the leaf to and, when it is not in use, why, with a reset where a value is stored.
 */
export function EmbeddingRow({ field, row }: { field: LeafField; row: LeafRow | undefined }) {
  const settings = useSettings();
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const [pending, setPendingProvider] = usePendingProvider();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [offer, setOffer] = useState<SwitchOffer | null>(null);
  const [confirming, setConfirming] = useState(false);
  const now = useNow();
  const choices = settings.data?.embedding;
  if (choices === undefined) return null;
  if (choices === null) {
    return field.kind === 'embedding-provider'
      ? <SettingRow setting={field.leaf} label={field.label} note={field.note} status="Myco could not read the embedding choices; reload to try again." refused control={null} />
      : null;
  }
  // A leaf this server does not offer, with nothing stored, has nothing to show or change.
  if (row !== undefined && !row.appliesTo.includes(choices.target) && !row.configured) return null;

  const leafOf = (leaf: string) => settings.data?.leaves.find((l) => l.leaf === leaf);
  const inUse = typeof leafOf('embedding.provider')?.effective === 'string' ? leafOf('embedding.provider')!.effective as string : null;
  const providerId = pending ?? inUse;
  const provider = choices.providers.find((p) => p.id === providerId) ?? null;
  const model = pending === null && typeof leafOf('embedding.model')?.effective === 'string' ? leafOf('embedding.model')!.effective as string : null;
  const storedEndpoint = pending === null && leafOf('embedding.base_url')?.configured === true && provider?.endpoint.editable === true
    ? leafOf('embedding.base_url')!.effective as string | null : null;
  const busy = actions.setEmbedding.isPending || actions.resetLeaf.isPending;
  const locked = !admin;
  const id = `leaf-${field.leaf}`;

  const choose = (choice: { provider: string; model?: string; endpoint?: string }) => {
    setError(null);
    if (locked) return;
    actions.setEmbedding.mutate(choice, {
      onError: (err) => setError(settingsRefusalText(err)),
      onSuccess: () => { setDraft(null); setPendingProvider(null); },
    });
  };
  const reset = () => {
    setError(null);
    if (locked) return;
    actions.resetLeaf.mutate({ leaf: field.leaf }, { onError: (err) => setError(settingsRefusalText(err)) });
  };
  const endpointOf = (): { endpoint?: string } => storedEndpoint === null ? {} : { endpoint: storedEndpoint };
  const pickModel = (next: string) => {
    if (provider === null) return;
    setError(null);
    setOffer(null);
    const listed = provider.models.find((m) => m.id === next);
    // A model the catalogue does not list is judged by the server; while search holds results, any change rebuilds it.
    const rebuilds = listed === undefined ? !choices.switchable && choices.switch === null && next !== model : listed.rebuilds;
    if (rebuilds && !locked) { setOffer({ provider: provider.id, label: provider.label, model: next, ...endpointOf() }); return; }
    const refusal = listed?.refusal ?? null;
    if (refusal !== null) { setError(refusal); return; }
    choose({ provider: provider.id, model: next, ...endpointOf() });
  };
  const offered = (o: SwitchOffer) => ({ provider: o.provider, model: o.model, ...(o.endpoint === undefined ? {} : { endpoint: o.endpoint }) });
  const confirmSwitch = () => {
    if (offer === null) return;
    actions.startSwitch.reset();
    actions.estimateSwitch.reset();
    actions.estimateSwitch.mutate(offered(offer));
    setConfirming(true);
  };
  const startSwitch = () => {
    if (offer === null || actions.estimateSwitch.data === undefined) return;
    actions.startSwitch.mutate(offered(offer), {
      onSuccess: () => { setOffer(null); setConfirming(false); setDraft(null); setPendingProvider(null); },
    });
  };

  const notInUse = row !== undefined && row.state !== 'active';
  const refused = error !== null;
  let status: string | null = error ?? (notInUse ? row!.reason : null);
  let control;
  let stacked = false;
  let labelled = true;

  if (field.kind === 'embedding-provider') {
    const none = choices.target === 'bun';
    control = (
      <Select
        id={id}
        label={field.label}
        value={providerId ?? (none ? NONE : '')}
        placeholder="Choose a provider"
        disabled={busy || locked || choices.switch !== null}
        options={[
          ...(none ? [{ value: NONE, label: 'None — search matches words only' }] : []),
          ...choices.providers.map((p) => ({ value: p.id, label: p.label, short: p.label.replace(/^Cloudflare /, '') })),
        ]}
        onValueChange={(next) => {
          setError(null);
          if (next === NONE) { setPendingProvider(null); if (row?.configured) reset(); return; }
          setPendingProvider(next === inUse ? null : next);
        }}
      />
    );
    if (pending !== null && provider !== null) status = `Choose a model below to switch search to ${provider.label}.`;
    status ??= inUseWords(choices);
  } else if (field.kind === 'embedding-model') {
    const underWay = choices.switch;
    stacked = provider?.customModels === true || offer !== null || underWay !== null;
    const listed = provider?.models ?? [];
    const shownModel = offer?.model ?? model;
    const options = [...listed.map((m) => modelOption(m, choices.capacity)), ...(shownModel !== null && !listed.some((m) => m.id === shownModel) ? [{ value: shownModel, label: `${shownModel} · ${dimensionWords(null)}`, short: shownModel }] : [])];
    labelled = provider !== null;
    control = provider === null ? <p aria-label={field.label} className="t-small text-muted">Choose a provider first.</p> : (
      <div className="flex w-full flex-col gap-s2">
        <Select id={id} label={field.label} value={shownModel ?? ''} placeholder="Choose a model" disabled={busy || locked || underWay !== null} options={options} onValueChange={pickModel} />
        {offer !== null && (
          <div className="flex flex-col items-start gap-s2" data-embedding-offer="">
            <p className="t-small text-ink-2">{offerWords(offer, choices)}</p>
            <div className="flex flex-wrap gap-s2">
              <Button size="sm" variant="primary" onClick={confirmSwitch}>Switch to this model</Button>
              <Button size="sm" variant="ghost" onClick={() => { setOffer(null); setDraft(null); }}>Keep {model === null ? 'the current model' : shortModel(model)}</Button>
            </div>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              tone="primary"
              title={`Switch search to ${shortModel(offer.model)}?`}
              description={`${offerWords(offer, choices)}${priceWords(offer)} You can cancel the switch until it is done.`}
              confirmLabel="Switch to this model"
              pending={actions.startSwitch.isPending}
              confirmDisabled={actions.estimateSwitch.data === undefined}
              error={actions.startSwitch.isError ? switchRefusalText(actions.startSwitch.error)
                : actions.estimateSwitch.isError ? switchRefusalText(actions.estimateSwitch.error) : null}
              onConfirm={startSwitch}
            >
              <p className="t-body text-ink" data-switch-estimate="">
                {actions.estimateSwitch.data !== undefined ? estimateWords(actions.estimateSwitch.data)
                  : actions.estimateSwitch.isError ? 'Myco could not estimate what this switch reads and costs, so it cannot start.' : 'Estimating what this switch reads and costs…'}
              </p>
              {actions.estimateSwitch.data !== undefined && (
                <PassedOverSources list={actions.estimateSwitch.data.passedOver}
                  lede={`${actions.estimateSwitch.data.passedOver.count === 1 ? 'This source has' : 'These sources have'} no search by meaning after the switch:`} />
              )}
            </ConfirmDialog>
          </div>
        )}
        {underWay !== null && <EmbeddingSwitchPanel sw={underWay} now={now} />}
        {provider.customModels && !locked && underWay === null && (
          <Input
            aria-label="Another model name"
            className="max-w-measure t-mono"
            placeholder="Another model this server has loaded"
            value={draft ?? ''}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft !== null && draft.trim() !== '') pickModel(draft.trim()); }}
            onBlur={() => { if (draft !== null && draft.trim() !== '') pickModel(draft.trim()); }}
          />
        )}
      </div>
    );
    const built = choices.held[0];
    if (underWay !== null) status = null;
    else if (status === null && built !== undefined && !choices.switchable && offer === null) {
      status = `Search was built with ${shortModel(built.model)}${built.dimensions === null ? '' : ` (${built.dimensions} dimensions)`}. Choosing another model offers to switch search to it, rebuilding search in the background.`;
    }
    if (status === null && model !== null) {
      const dimensions = listed.find((m) => m.id === model)?.dimensions ?? null;
      status = `${dimensions === null ? 'The model’s dimensions are not published.' : `The model uses ${dimensions} dimensions.`}${row?.source === 'default' ? ' This is the provider’s default model.' : ''}`;
    }
  } else {
    const editable = provider?.endpoint.editable === true;
    const shown = draft ?? (storedEndpoint ?? '');
    const commit = () => {
      if (draft === null || provider === null) return;
      if (draft.trim() === '') { if (row?.configured) reset(); setDraft(null); return; }
      choose({ provider: provider.id, ...(model === null ? {} : { model }), endpoint: draft.trim() });
    };
    labelled = editable;
    control = editable ? (
      <Input
        id={id}
        aria-label={field.label}
        className="max-w-measure"
        value={shown}
        readOnly={locked || choices.switch !== null}
        placeholder={provider?.endpoint.url ?? 'http://models.internal:8080/v1'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    ) : (
      <p aria-label={field.label} className="t-small text-muted">{provider === null ? 'No provider is chosen.' : provider.endpoint.url ?? `${provider.label} on this server`}</p>
    );
    status ??= editable ? (storedEndpoint === null ? `Search uses the default endpoint: ${provider?.endpoint.url ?? 'none'}.` : null) : provider === null ? null : `${provider.label} uses its own endpoint.`;
  }

  return (
    <SettingRow
      setting={field.leaf}
      label={field.label}
      htmlFor={labelled ? id : undefined}
      note={field.note}
      details={row?.configured ? <StoredValue value={row.stored} /> : undefined}
      status={[status === null ? null : /[.!?]$/.test(status) ? status : `${status}.`, (field.kind === 'embedding-provider' || notInUse) && status !== inUseWords(choices) ? inUseWords(choices) : null, null].filter(Boolean).join(' ')}
      refused={refused}
      stacked={stacked || row?.configured === true}
      control={(
        <div className={`flex w-full flex-col items-start gap-s2${stacked || row?.configured === true ? ' max-w-measure' : ''}`}>
          <div className="flex w-full min-w-0 items-center gap-s2">{control}</div>
          {row?.configured === true && !locked && choices.switch === null && <Button size="sm" aria-label={`Clear the stored value for ${field.label}`} disabled={busy} onClick={reset}>Clear the stored value</Button>}
          {row?.configured && !locked && <p className="t-meta text-muted">Clearing restores this setting’s effective default.</p>}
        </div>
      )}
    />
  );
}
