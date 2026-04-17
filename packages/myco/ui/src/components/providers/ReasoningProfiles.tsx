import { Input } from '../ui/input';
import { SearchableSelect } from '../ui/searchable-select';
import { resolveReasoningModel } from '../../hooks/use-providers';

export type ReasoningLevel = 'low' | 'default' | 'high';

const LEVELS: ReadonlyArray<readonly [ReasoningLevel, string]> = [
  ['low', 'Reasoning Low'],
  ['default', 'Reasoning Default'],
  ['high', 'Reasoning High'],
];

export interface ReasoningProfilesProps {
  description: string;
  values: Record<ReasoningLevel, string>;
  onChange: (level: ReasoningLevel, value: string) => void;
  models: string[];
  fallbackModel?: string;
  fallbackReasoningMap?: Partial<Record<ReasoningLevel, string>>;
  placeholderWhenEmpty?: string;
}

/**
 * Reasoning profile editor (low / default / high model selections).
 * Shared between the global Agent Provider settings card and per-task
 * TaskProviderConfig override. The calling component controls the draft
 * state; this component only renders the fields.
 */
export function ReasoningProfiles({
  description,
  values,
  onChange,
  models,
  fallbackModel,
  fallbackReasoningMap,
  placeholderWhenEmpty = 'Use default model',
}: ReasoningProfilesProps) {
  const reasoningMap = {
    ...(values.low ? { low: values.low } : {}),
    ...(values.default ? { default: values.default } : {}),
    ...(values.high ? { high: values.high } : {}),
  };

  return (
    <div className="space-y-3 rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest p-3">
      <div>
        <p className="font-sans text-xs text-on-surface-variant uppercase tracking-wide">Reasoning Profiles</p>
        <p className="font-sans text-xs text-on-surface-variant/80 mt-1">{description}</p>
      </div>
      {LEVELS.map(([level, label]) => {
        const value = values[level];
        // Precedence for placeholder:
        //   this scope's reasoning_map[level]  (values[level], held in reasoningMap)
        //     -> inherited per-level fallback  (fallbackReasoningMap[level])
        //       -> generic fallback model      (fallbackModel)
        // Do NOT pass `model: fallbackModel` into the provider — that would
        // short-circuit the per-level fallback since resolveReasoningModel
        // prefers provider.model over its fallbackModel argument.
        const placeholder = resolveReasoningModel(
          level,
          { reasoning_map: reasoningMap },
          fallbackReasoningMap?.[level] ?? fallbackModel,
        );
        const resolvedPlaceholder = placeholder || placeholderWhenEmpty;
        return (
          <div key={level} className="space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">{label}</label>
            {models.length > 0 ? (
              <SearchableSelect
                value={value}
                onValueChange={(next) => onChange(level, next)}
                placeholder={resolvedPlaceholder}
                searchPlaceholder="Search models..."
                emptyMessage="No models match that search."
                options={models.map((candidate) => ({ value: candidate, label: candidate }))}
                sortOptions
                monospace
              />
            ) : (
              <Input
                value={value}
                onChange={(e) => onChange(level, e.target.value)}
                placeholder={resolvedPlaceholder}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
