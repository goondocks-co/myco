import { useState, type ReactElement } from 'react';
import { offeredPresets, REASONING_TIERS, type CatalogModel, type ModelPreset } from '@goondocks/myco-shared/execution-profile';
import { Button, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettings, useSettingsActions } from '../../../hooks/use-settings';
import { harnessLabel } from '../../../lib/harness';
import { ago } from '../../today/words';
import { SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { LeafField } from './catalogue';
import { defaultWords, savedWords } from './LeafControl';
import type { LeafRow, SettingsModelCatalog } from './wire';

/** The provider filter's value for every provider. */
const ALL_PROVIDERS = '__all__';

/** The models every worker listed for one agent, each once, newest list first, and when the newest was listed. */
export interface ListedModels {
  models: CatalogModel[];
  providers: string[];
  listedAt: number;
}

/** What the workers listed for `harness`, or null where none has listed its models. */
export function listedModels(catalogs: readonly SettingsModelCatalog[] | undefined, harness: string): ListedModels | null {
  const mine = (catalogs ?? []).filter((catalog) => catalog.harness === harness);
  if (mine.length === 0) return null;
  const byId = new Map<string, CatalogModel>();
  for (const catalog of mine) for (const model of catalog.models) if (!byId.has(model.id)) byId.set(model.id, model);
  const models = [...byId.values()];
  const providers = [...new Set(models.flatMap((model) => (model.provider === undefined ? [] : [model.provider])))].sort();
  return { models, providers, listedAt: Math.max(...mine.map((catalog) => catalog.fetchedAt)) };
}

/** A model as its option reads: the name the agent gives it, with its id where the name is not the id. */
export function modelWords(model: CatalogModel): string {
  const named = model.label === model.id ? model.id : `${model.label} (${model.id})`;
  return model.isDefault === true ? `${named}, the agent's default` : named;
}

/**
 * A tier's model, chosen from the models the workers listed for its agent, filtered by provider where they span more
 * than one. A stored model no worker listed stays chosen and is said to be missing; a listed model with a successor
 * says so and offers it. Where no worker has listed the agent's models, the model is typed, as `textControl` does.
 */
export function ModelRow({ field, row, textControl }: { field: LeafField; row: LeafRow | undefined; textControl: ReactElement }) {
  const settings = useSettings();
  const listed = listedModels(settings.data?.models, field.harness ?? '');
  const [typing, setTyping] = useState(false);
  if (listed === null || typing) return textControl;
  return <ListedModelRow field={field} row={row} listed={listed} onType={() => setTyping(true)} />;
}

function ListedModelRow({ field, row, listed, onType }: { field: LeafField; row: LeafRow | undefined; listed: ListedModels; onType: () => void }) {
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const nameOf = useMemberNames();
  const [error, setError] = useState<string | null>(null);
  const stored = row?.configured === true && typeof row.value === 'string' ? row.value : null;
  const current = stored ?? (typeof row?.effectiveValue === 'string' ? row.effectiveValue : null);
  const known = current === null ? undefined : listed.models.find((model) => model.id === current);
  const [provider, setProvider] = useState<string>(known?.provider ?? ALL_PROVIDERS);
  const pending = actions.setLeaf.isPending || actions.resetLeaf.isPending;
  const locked = !admin;
  const id = `leaf-${field.leaf}`;

  const save = (value: string) => {
    setError(null);
    if (locked) return;
    actions.setLeaf.mutate({ leaf: field.leaf, value }, { onError: (failure) => setError(settingsRefusalText(failure)) });
  };
  const reset = () => {
    setError(null);
    if (locked) return;
    actions.resetLeaf.mutate({ leaf: field.leaf }, { onError: (failure) => setError(settingsRefusalText(failure)) });
  };

  const shown = listed.models.filter((model) => provider === ALL_PROVIDERS || model.provider === provider);
  const options = [
    ...(current !== null && known === undefined ? [{ value: current, label: `${current} (not listed)` }] : []),
    ...shown.map((model) => ({ value: model.id, label: modelWords(model), short: model.label === model.id ? model.id : model.label, searchText: model.provider })),
  ];
  const successor = known?.upgrade === undefined ? undefined : listed.models.find((model) => model.id === known.upgrade);
  const listedWhen = `Listed by your machines ${ago(listed.listedAt, Date.now())}.`;
  const agent = harnessLabel(field.harness ?? '');
  const statusWords = (): string => {
    if (error !== null) return error;
    if ((row?.state === 'invalid' || row?.state === 'not-applicable') && (row.remedy ?? row.reason) != null) return (row.remedy ?? row.reason)!;
    if (current !== null && known === undefined) return `${current} is not among the models your machines listed for ${agent}. Check the name, or choose a listed model.`;
    if (known?.upgrade !== undefined) return `${agent} names ${successor?.label ?? known.upgrade} as the successor to ${known.label}.`;
    const applied = row?.source === 'default' && typeof row.effectiveValue === 'string' ? (known?.label ?? row.effectiveValue) : defaultWords(field);
    return savedWords(row, row?.configured ? nameOf(row.updatedBy) : null, Date.now(), applied);
  };
  const status = statusWords();

  return (
    <SettingRow
      setting={field.leaf}
      label={field.label}
      htmlFor={id}
      note={listedWhen}
      status={status}
      refused={error !== null || row?.state === 'invalid' || row?.state === 'not-applicable'}
      stacked
      control={(
        <div className="flex w-full flex-col gap-s2" data-model-picker={field.harness}>
          <div className="flex w-full flex-wrap items-center gap-s2">
            {listed.providers.length > 1 && (
              <div className="w-full sm:w-select-wide">
                <Select
                  label={`${field.label} provider`}
                  value={provider}
                  disabled={pending}
                  options={[{ value: ALL_PROVIDERS, label: 'All providers' }, ...listed.providers.map((name) => ({ value: name, label: name }))]}
                  onValueChange={setProvider}
                />
              </div>
            )}
            <div className="min-w-0 flex-1 sm:max-w-measure">
              <Select
                id={id}
                label={field.label}
                value={current ?? ''}
                placeholder="Choose a model"
                disabled={pending || locked}
                options={options}
                onValueChange={save}
              />
            </div>
            {row?.configured === true && !locked && <Button size="sm" aria-label={`Reset ${field.label}`} disabled={pending} onClick={reset}>Reset</Button>}
          </div>
          {!locked && (
            <div className="flex flex-wrap gap-s2">
              {known?.upgrade !== undefined && (
                <Button size="sm" disabled={pending} onClick={() => save(known.upgrade!)}>{`Use ${successor?.label ?? known.upgrade}`}</Button>
              )}
              <Button size="sm" variant="ghost" onClick={onType}>Type a model name</Button>
            </div>
          )}
        </div>
      )}
    />
  );
}

/**
 * The presets an agent's manifest declares for a provider a worker reports it is logged in to, each one choice that
 * sets the model of every tier. Each tier is written on its own, through the same write as choosing it by hand.
 */
export function ModelPresets({ harness }: { harness: string }) {
  const settings = useSettings();
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const [outcome, setOutcome] = useState<{ preset: string; words: string; refused: boolean } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const presets = offeredPresets(harness, settings.data?.models ?? []);
  if (presets.length === 0 || !admin) return null;

  const apply = async (preset: ModelPreset) => {
    setOutcome(null);
    setApplying(preset.id);
    for (const tier of REASONING_TIERS) {
      try {
        await actions.setLeaf.mutateAsync({ leaf: `agent.reasoning_map.${harness}.${tier}`, value: preset.models[tier] });
      } catch (failure) {
        setOutcome({ preset: preset.id, words: `The ${tier} tier was not set: ${settingsRefusalText(failure)}`, refused: true });
        setApplying(null);
        return;
      }
    }
    setOutcome({ preset: preset.id, words: 'Every tier now uses these models.', refused: false });
    setApplying(null);
  };

  return (
    <>
      {presets.map((preset) => (
        <SettingRow
          key={preset.id}
          setting={`preset-${harness}-${preset.id}`}
          label={preset.label}
          note={`Sets ${REASONING_TIERS.map((tier) => `${tier} to ${preset.models[tier]}`).join(', ')}. Offered because your machines are signed in to ${preset.provider}.`}
          status={outcome?.preset === preset.id ? outcome.words : undefined}
          refused={outcome?.preset === preset.id && outcome.refused}
          control={<Button size="sm" disabled={applying !== null} pending={applying === preset.id} onClick={() => void apply(preset)}>Use these models</Button>}
        />
      ))}
    </>
  );
}
