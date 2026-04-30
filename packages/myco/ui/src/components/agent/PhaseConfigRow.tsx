/**
 * Per-phase config row — collapsible. Used by both TaskProviderConfig (edits
 * persisted myco.yaml phase overrides) and RunTaskDialog (edits per-run phase
 * overrides that apply to a single run only).
 *
 * The emitted `PhaseOverride` shape has the same fields in both call sites —
 * `{ provider, model, maxTurns }` — but the two sites interpret it differently:
 *   - TaskProviderConfig persists the override to myco.yaml.
 *   - RunTaskDialog posts the override inside `executionOverrides.phases` for
 *     the single run only.
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
} from '../../hooks/use-providers';
import type { PhaseDefinition } from '../../hooks/use-agent';

export interface PhaseConfigRowProps {
  phase: PhaseDefinition;
  override: PhaseOverride;
  taskHarness: string;
  taskProviderType: string;
  taskModel: string;
  taskReasoningMap?: Partial<Record<'low' | 'default' | 'high', string>>;
  providers: ProviderInfo[];
  isLoadingProviders: boolean;
  onChange: (update: PhaseOverride | null) => void;
}

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
  const hasOverride = override.provider !== undefined || override.model !== undefined || override.maxTurns !== undefined;
  const modelPlaceholder = phase.model
    ?? resolveReasoningModel(
      phase.reasoningLevel,
      {
        model: taskModel || undefined,
        reasoning_map: taskReasoningMap,
      },
      taskModel,
    );

  return (
    <div className="border border-[var(--ghost-border)] rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-container-low/50 transition-colors rounded-md"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />}
        <span className="font-sans text-sm text-on-surface">{phase.name}</span>
        <span className="font-mono text-xs text-on-surface-variant">max {override.maxTurns ?? phase.maxTurns} turns</span>
        {hasOverride && <Badge variant="secondary" className="text-[10px] ml-auto">override</Badge>}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-[var(--ghost-border)]">
          <div className="pt-3">
            <ProviderModelSelector
              harness={taskHarness}
              providerType={override.provider?.type ?? taskProviderType}
              localBackend={override.provider?.local_backend ?? ''}
              model={override.provider?.model ?? override.model ?? ''}
              baseUrl={override.provider?.base_url ?? ''}
              contextLength={override.provider?.context_length != null ? String(override.provider.context_length) : ''}
              modelPlaceholder={modelPlaceholder}
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

          <div className="space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">Max Turns</label>
            <Input
              type="number"
              value={override.maxTurns ?? ''}
              onChange={(e) => onChange({ ...override, maxTurns: e.target.value ? Number(e.target.value) : undefined })}
              placeholder={String(phase.maxTurns)}
            />
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
