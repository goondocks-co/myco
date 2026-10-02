import { useState } from 'react';
import type { EmbeddingChoices, EmbeddingModelChoice, EmbeddingProviderChoice } from '@goondocks/myco-shared/settings-contract';
import { Button, Input, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettings, useSettingsActions } from '../../../hooks/use-settings';
import { SettingRow } from '../AdminFrame';
import type { LeafField } from './catalogue';
import type { LeafRow } from './wire';

/** The option that turns semantic search off on a server whose default is none. */
const NONE = '__none__';

/** A model's name without its provider's prefix: `@cf/baai/bge-m3` reads as `bge-m3`. */
export const shortModel = (id: string): string => id.split('/').at(-1) ?? id;

const dimensionWords = (dimensions: number | null): string => dimensions === null ? 'size not published' : `${dimensions} dimensions`;

/** One model as the picker lists it: its name, its vector size, and whether it needs a re-index first. */
const modelOption = (model: EmbeddingModelChoice, capacity: number) => ({
  value: model.id,
  label: `${model.id} · ${dimensionWords(model.dimensions)}${model.refusal === null ? '' : model.dimensions !== null && model.dimensions > capacity ? ' · too large for search' : ' · needs a re-index'}`,
  short: model.id,
});

/** What search uses now, in words: `Cloudflare Workers AI · bge-m3`, or why it matches words only. */
export function inUseWords(choices: EmbeddingChoices): string {
  const selection = choices.selection;
  if (selection === null) return choices.reason ?? 'Search matches words only.';
  const label = choices.providers.find((p) => p.id === selection.provider)?.label ?? selection.provider;
  const words = `In use: ${label} · ${shortModel(selection.model)} (${dimensionWords(selection.dimensions)})`;
  return choices.reason === null ? words : `${words}. ${choices.reason}`;
}

/** The model a provider starts on: its default, unless the index's vectors rule it out, then the first that fits. */
function startingModel(provider: EmbeddingProviderChoice): string {
  const fits = provider.models.filter((m) => m.refusal === null);
  return fits.some((m) => m.id === provider.defaultModel) || fits.length === 0 ? provider.defaultModel : fits[0]!.id;
}

/**
 * One row of the embedding picker. Provider, model and endpoint are written together through one request, so a
 * provider never meets a model or endpoint it does not offer; each row shows what the server resolves the leaf to
 * and, when it is not in use, why, with a reset where a value is stored.
 */
export function EmbeddingRow({ field, row }: { field: LeafField; row: LeafRow | undefined }) {
  const settings = useSettings();
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const choices = settings.data?.embedding;
  if (choices === undefined) return null;
  // A leaf this server does not offer, with nothing stored, has nothing to show or change.
  if (row !== undefined && !row.appliesTo.includes(choices.target) && !row.configured) return null;

  const leafOf = (leaf: string) => settings.data?.leaves.find((l) => l.leaf === leaf);
  const providerId = typeof leafOf('embedding.provider')?.effective === 'string' ? leafOf('embedding.provider')!.effective as string : null;
  const provider = choices.providers.find((p) => p.id === providerId) ?? null;
  const model = typeof leafOf('embedding.model')?.effective === 'string' ? leafOf('embedding.model')!.effective as string : null;
  const storedEndpoint = leafOf('embedding.base_url')?.configured === true && provider?.endpoint.editable === true ? leafOf('embedding.base_url')!.effective as string | null : null;
  const pending = actions.setEmbedding.isPending || actions.resetLeaf.isPending;
  const locked = !admin;
  const id = `leaf-${field.leaf}`;

  const choose = (choice: { provider: string; model?: string; endpoint?: string }) => {
    setError(null);
    if (locked) return;
    actions.setEmbedding.mutate(choice, { onError: (err) => setError(settingsRefusalText(err)), onSuccess: () => setDraft(null) });
  };
  const reset = () => {
    setError(null);
    if (locked) return;
    actions.resetLeaf.mutate({ leaf: field.leaf }, { onError: (err) => setError(settingsRefusalText(err)) });
  };
  const pickModel = (next: string) => {
    if (provider === null) return;
    const refusal = provider.models.find((m) => m.id === next)?.refusal ?? null;
    if (refusal !== null) { setError(refusal); return; }
    choose({ provider: provider.id, model: next, ...(storedEndpoint === null ? {} : { endpoint: storedEndpoint }) });
  };

  const notInUse = row !== undefined && row.state !== 'active';
  const refused = error !== null || row?.state === 'invalid' || row?.state === 'not-applicable';
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
        disabled={pending || locked}
        options={[
          ...(none ? [{ value: NONE, label: 'None — search matches words only' }] : []),
          ...choices.providers.map((p) => ({ value: p.id, label: p.label, short: p.label.replace(/^Cloudflare /, '') })),
        ]}
        onValueChange={(next) => {
          if (next === NONE) { if (row?.configured) reset(); return; }
          const picked = choices.providers.find((p) => p.id === next);
          if (picked !== undefined && picked.id !== providerId) choose({ provider: picked.id, model: startingModel(picked) });
        }}
      />
    );
    status ??= inUseWords(choices);
  } else if (field.kind === 'embedding-model') {
    stacked = provider?.customModels === true;
    const listed = provider?.models ?? [];
    const options = [...listed.map((m) => modelOption(m, choices.capacity)), ...(model !== null && !listed.some((m) => m.id === model) ? [{ value: model, label: `${model} · ${dimensionWords(null)}`, short: model }] : [])];
    labelled = provider !== null;
    control = provider === null ? <p aria-label={field.label} className="t-small text-muted">Choose a provider first.</p> : (
      <div className="flex w-full flex-col gap-s2">
        <Select id={id} label={field.label} value={model ?? ''} placeholder={provider.defaultModel} disabled={pending || locked} options={options} onValueChange={pickModel} />
        {provider.customModels && !locked && (
          <Input
            aria-label="Another model name"
            className="max-w-measure t-mono"
            placeholder="Another model this server has loaded"
            value={draft ?? ''}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft !== null && draft.trim() !== '') pickModel(draft.trim()); }}
            onBlur={() => { if (draft !== null && draft.trim() !== '') pickModel(draft.trim()); }}
          />
        )}
      </div>
    );
    const held = choices.held[0];
    if (status === null && held !== undefined) {
      status = `Search holds ${held.dimensions === null ? '' : `${held.dimensions}-dimension `}vectors from ${shortModel(held.model)}; a model of another size needs a re-index.`;
    }
    if (status === null && model !== null) status = `${dimensionWords(listed.find((m) => m.id === model)?.dimensions ?? null)}${row?.source === 'default' ? ' · the provider’s default' : ''}`;
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
        readOnly={locked}
        placeholder={provider?.endpoint.url ?? 'http://models.internal:8080/v1'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
      />
    ) : (
      <p aria-label={field.label} className="t-small text-muted">{provider === null ? 'No provider is chosen.' : provider.endpoint.url ?? `${provider.label} on this server`}</p>
    );
    status ??= editable ? (storedEndpoint === null ? `Default: ${provider?.endpoint.url ?? 'none'}` : null) : provider === null ? null : `${provider.label} uses its own endpoint.`;
  }

  return (
    <SettingRow
      setting={field.leaf}
      label={field.label}
      htmlFor={labelled ? id : undefined}
      note={field.note}
      status={status}
      refused={refused}
      stacked={stacked || row?.configured === true}
      control={(
        <div className={`flex w-full items-center gap-s2${stacked || row?.configured === true ? ' max-w-measure' : ''}`}>
          {control}
          {row?.configured === true && !locked && <Button size="sm" aria-label={`Reset ${field.label}`} disabled={pending} onClick={reset}>Reset</Button>}
        </div>
      )}
    />
  );
}
