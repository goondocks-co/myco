/**
 * Per-phase config row — collapsible. Used by both TaskProviderConfig (edits
 * persisted grove.yaml phase overrides — task config is grove-scoped) and
 * RunTaskDialog (edits per-run phase overrides that apply to a single run
 * only).
 *
 * The emitted `PhaseOverride` shape has the same fields in both call sites —
 * `{ provider, reasoningLevel, model, maxTurns }` — but the two sites
 * interpret it differently:
 *   - TaskProviderConfig persists the override to grove.yaml.
 *   - RunTaskDialog posts the override inside `executionOverrides.phases` for
 *     the single run only.
 *
 * **Reasoning level is the primary tier control.** Edits should set
 * `reasoningLevel` (low/default/high), which resolves through the provider's
 * `reasoning_map` at execution time. A direct `model` override is the escape
 * hatch — only useful when you need to pin a specific SKU regardless of the
 * tier. The form puts model behind an Advanced disclosure to keep it from
 * silently shadowing the tier system.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { ProviderModelSelector } from '../providers/ProviderModelSelector';
import {
  resolveReasoningModel,
  type ProviderConfig,
  type ProviderInfo,
  type PhaseOverride,
  type ReasoningLevelUi,
} from '../../hooks/use-providers';
import type { PhaseDefinition } from '../../hooks/use-agent';

export interface PhaseConfigRowProps {
  phase: PhaseDefinition;
  override: PhaseOverride;
  taskHarness: string;
  taskProviderType: string;
  taskModel: string;
  taskReasoningMap?: Partial<Record<ReasoningLevelUi, string>>;
  providers: ProviderInfo[];
  isLoadingProviders: boolean;
  onChange: (update: PhaseOverride | null) => void;
}

const REASONING_LEVELS: ReasoningLevelUi[] = ['low', 'default', 'high'];

export function PhaseConfigRow({
  phase,
  override,
  taskHarness,
  taskProviderType,
  taskModel,
  taskReasoningMap,
  providers,
  isLoadingProviders,
  onChange,
}: PhaseConfigRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(
    // Auto-open Advanced if a model override already exists — so users editing
    // a pre-existing legacy override see the field instead of being confused.
    override.provider?.model !== undefined || override.model !== undefined,
  );

  const effectiveReasoning =
    override.reasoningLevel ?? phase.reasoningLevel ?? 'default';

  const resolvedModel =
    override.provider?.model
    ?? override.model
    ?? phase.model
    ?? resolveReasoningModel(
      effectiveReasoning,
      {
        model: taskModel || undefined,
        reasoning_map: taskReasoningMap,
      },
      taskModel,
    )
    ?? '(unresolved)';

  const hasOverride =
    override.provider !== undefined
    || override.model !== undefined
    || override.reasoningLevel !== undefined
    || override.maxTurns !== undefined;

  return (
    <div className="border border-[var(--ghost-border)] rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-container-low/50 transition-colors rounded-md"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />}
        <span className="font-sans text-sm text-on-surface">{phase.name}</span>
        <span className="font-mono text-xs text-on-surface-variant">
          {effectiveReasoning} · max {override.maxTurns ?? phase.maxTurns} turns
        </span>
        {hasOverride && <Badge variant="secondary" className="text-[10px] ml-auto">override</Badge>}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-[var(--ghost-border)]">
          {/* Reasoning Level — the primary per-phase control. */}
          <div className="pt-3 space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">Reasoning Level</label>
            <select
              className="w-full bg-surface-container-low border border-[var(--ghost-border)] rounded-md px-3 py-2 text-sm font-mono text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
              value={override.reasoningLevel ?? ''}
              onChange={(e) => {
                const v = e.target.value as '' | ReasoningLevelUi;
                onChange({
                  ...override,
                  reasoningLevel: v === '' ? undefined : v,
                });
              }}
            >
              <option value="">
                inherit ({phase.reasoningLevel ?? 'default'})
              </option>
              {REASONING_LEVELS.map((lvl) => (
                <option key={lvl} value={lvl}>{lvl}</option>
              ))}
            </select>
            <p className="font-sans text-[11px] text-on-surface-variant">
              Resolves to <span className="font-mono">{resolvedModel}</span> via the provider's reasoning map.
            </p>
          </div>

          <div className="space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">Max Turns</label>
            <Input
              type="number"
              value={override.maxTurns ?? ''}
              onChange={(e) => onChange({ ...override, maxTurns: e.target.value ? Number(e.target.value) : undefined })}
              placeholder={String(phase.maxTurns)}
            />
          </div>

          {/* Provider + model edit lives behind Advanced. Direct model pinning
              defeats the tier system — useful for narrow A/B tests but should
              not be the default per-phase control. */}
          <div className="border-t border-[var(--ghost-border)] pt-3">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex items-center gap-1 text-xs text-on-surface-variant hover:text-on-surface"
            >
              {advancedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Advanced — pin provider / model
            </button>
            {advancedOpen && (
              <div className="pt-2">
                <p className="font-sans text-[11px] text-on-surface-variant pb-2">
                  Pinning a model overrides the reasoning map for this phase.
                  Future model upgrades won't propagate here until you clear it.
                </p>
                <ProviderModelSelector
                  harness={taskHarness}
                  providerType={override.provider?.type ?? taskProviderType}
                  localBackend={override.provider?.local_backend ?? ''}
                  model={override.provider?.model ?? override.model ?? ''}
                  baseUrl={override.provider?.base_url ?? ''}
                  contextLength={override.provider?.context_length != null ? String(override.provider.context_length) : ''}
                  modelPlaceholder={resolvedModel}
                  providers={providers}
                  isLoadingProviders={isLoadingProviders}
                  showHarnessSelector={false}
                  onHarnessChange={() => {}}
                  onProviderChange={(type) => {
                    const bp = providers.find(p => p.type === type)?.baseUrl;
                    onChange({
                      ...override,
                      provider: {
                        type: type as ProviderConfig['type'],
                        base_url: bp,
                      },
                      model: undefined,
                    });
                  }}
                  onLocalBackendChange={(localBackend) => onChange({
                    ...override,
                    provider: {
                      ...(override.provider ?? { type: (taskProviderType as ProviderConfig['type']) }),
                      local_backend: localBackend || undefined,
                    },
                  })}
                  onModelChange={(m) => onChange({
                    ...override,
                    provider: {
                      ...(override.provider ?? { type: (taskProviderType as ProviderConfig['type']) }),
                      model: m,
                    },
                    model: undefined,
                  })}
                  onBaseUrlChange={(url) => onChange({
                    ...override,
                    provider: {
                      ...(override.provider ?? { type: (taskProviderType as ProviderConfig['type']) }),
                      base_url: url,
                    },
                  })}
                  onContextLengthChange={(ctx) => onChange({
                    ...override,
                    provider: {
                      ...(override.provider ?? { type: (taskProviderType as ProviderConfig['type']) }),
                      context_length: ctx ? Number(ctx) : undefined,
                    },
                  })}
                />
              </div>
            )}
          </div>

          {hasOverride && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)} className="text-xs text-on-surface-variant">
              Clear Phase Override
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
