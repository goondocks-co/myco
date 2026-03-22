import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  Field,
  LLM_PROVIDERS,
  CONTEXT_WINDOW_SELECT_OPTIONS,
  COOLDOWN_STAGE_LABELS,
  COOLDOWN_STAGE_DESCRIPTIONS,
  RECOMMENDED_DIGEST,
  NativeSelect,
  ToggleSwitch,
} from './config-helpers';
import { ModelSelect } from './ModelSelect';

// Built-in digest tiers and their minimum context requirements.
// These are constants, not user-configurable — eligibility is
// determined by the digest model's context window.
const BUILT_IN_TIERS = [1500, 3000, 5000, 7500, 10000] as const;
const TIER_MIN_CONTEXT: Record<number, number> = {
  1500: 6500,
  3000: 11500,
  5000: 18500,
  7500: 24500,
  10000: 30500,
};

interface DigestSectionProps {
  digest: MycoConfig['digest'];
  intelligence: MycoConfig['intelligence'];
  isDirty: boolean;
  updateDigest: (key: string, value: unknown) => void;
  updateDigestIntelligence: (key: string, value: unknown) => void;
  updateDigestMetabolism: (key: string, value: unknown) => void;
  updateDigestSubstrate: (key: string, value: number) => void;
  updateDigestConsolidation: (key: string, value: unknown) => void;
}

export function DigestSection({
  digest,
  intelligence,
  isDirty,
  updateDigest,
  updateDigestIntelligence,
  updateDigestMetabolism,
  updateDigestSubstrate,
  updateDigestConsolidation,
}: DigestSectionProps) {
  const digestProvider = digest.intelligence.provider ?? intelligence.llm.provider;
  const digestBaseUrl = digest.intelligence.base_url ?? intelligence.llm.base_url;
  return (
    <ConfigSection
      title="Digest"
      description="Continuous synthesis of vault knowledge into pre-computed context"
      isDirty={isDirty}
    >
      <div className="space-y-6">
        <Field label="Enabled" description="Run continuous vault synthesis in the background">
          <ToggleSwitch
            checked={digest.enabled}
            onChange={(v) => updateDigest('enabled', v)}
          />
        </Field>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Consolidation</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Enabled" description="Automatically consolidate related spores into wisdom notes before each digest cycle">
              <ToggleSwitch
                checked={digest.consolidation.enabled}
                onChange={(v) => updateDigestConsolidation('enabled', v)}
              />
            </Field>
            <Field label="Max Tokens" description="Token budget for wisdom note generation — higher values produce more comprehensive notes">
              <Input
                type="number"
                value={digest.consolidation.max_tokens}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestConsolidation('max_tokens', val);
                }}
              />
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Intelligence</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Override the processor model for digest — use a larger model for better synthesis">
              <NativeSelect
                value={digest.intelligence.provider ?? '__null__'}
                onChange={(v) =>
                  updateDigestIntelligence('provider', v === '__null__' ? null : v)
                }
                options={[
                  { value: '__null__', label: 'Use main provider' },
                  ...LLM_PROVIDERS.map((p) => ({ value: p, label: p })),
                ]}
              />
            </Field>
            <Field label="Model" description="Digest model — quality matters more than speed here">
              <ModelSelect
                provider={digestProvider}
                baseUrl={digestBaseUrl}
                value={digest.intelligence.model ?? ''}
                onChange={(v) => updateDigestIntelligence('model', v || null)}
                placeholder="Use main model"
                modelType="llm"
              />
            </Field>
            <Field label="Context Window" description="How much vault content the digest model can process per cycle">
              <NativeSelect
                value={String(digest.intelligence.context_window)}
                onChange={(v) =>
                  updateDigestIntelligence('context_window', parseInt(v, 10))
                }
                options={CONTEXT_WINDOW_SELECT_OPTIONS}
              />
            </Field>
            <Field label="Keep Alive" description="How long to keep the digest model loaded between cycles (Ollama duration string)">
              <Input
                value={digest.intelligence.keep_alive ?? ''}
                placeholder="Provider default"
                onChange={(e) =>
                  updateDigestIntelligence('keep_alive', e.target.value || null)
                }
              />
            </Field>
            <Field label="GPU KV Cache" description="Offload key-value cache to GPU — faster but uses more VRAM">
              <ToggleSwitch
                checked={digest.intelligence.gpu_kv_cache}
                onChange={(v) => updateDigestIntelligence('gpu_kv_cache', v)}
              />
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Tiers</h4>
          <Field label="Token budgets" description="Built-in tiers — eligible tiers are determined by your digest model's context window">
            <div className="flex flex-wrap gap-2">
              {BUILT_IN_TIERS.map((tier) => {
                const minCtx = TIER_MIN_CONTEXT[tier] ?? Infinity;
                const eligible = minCtx <= (digest.intelligence.context_window ?? 0);
                return (
                  <Badge
                    key={tier}
                    variant={eligible ? 'secondary' : 'outline'}
                    className={eligible ? '' : 'opacity-40'}
                    title={eligible
                      ? `Eligible — requires ${minCtx.toLocaleString()} context`
                      : `Requires ${minCtx.toLocaleString()} context (current: ${(digest.intelligence.context_window ?? 0).toLocaleString()})`
                    }
                  >
                    {tier.toLocaleString()}
                  </Badge>
                );
              })}
            </div>
          </Field>
          <div className="mt-4">
            <Field label="Inject Tier" description="Which tier to inject at session start — larger tiers give agents more context">
              <NativeSelect
                value={digest.inject_tier !== null ? String(digest.inject_tier) : '__null__'}
                onChange={(v) =>
                  updateDigest('inject_tier', v === '__null__' ? null : parseInt(v, 10))
                }
                options={[
                  { value: '__null__', label: 'None (disabled)' },
                  ...BUILT_IN_TIERS.map((tier) => ({
                    value: String(tier),
                    label: `${tier.toLocaleString()} tokens`,
                  })),
                ]}
              />
            </Field>
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-medium text-muted-foreground">Metabolism</h4>
            <button
              type="button"
              onClick={() => {
                const r = RECOMMENDED_DIGEST.metabolism;
                updateDigestMetabolism('active_interval', r.active_interval);
                updateDigestMetabolism('dormancy_threshold', r.dormancy_threshold);
                updateDigestMetabolism('cooldown_intervals', [...r.cooldown_intervals]);
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Reset to recommended
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Active Interval (sec)" description="Seconds between digest cycles when new content is arriving">
              <Input
                type="number"
                value={digest.metabolism.active_interval}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestMetabolism('active_interval', val);
                }}
              />
            </Field>
            <Field label="Dormancy Threshold (sec)" description="Seconds of inactivity before the digest engine goes dormant">
              <Input
                type="number"
                value={digest.metabolism.dormancy_threshold}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestMetabolism('dormancy_threshold', val);
                }}
              />
            </Field>
          </div>
          <div className="mt-4">
            <h5 className="mb-3 text-xs font-medium text-muted-foreground">
              Cooldown Intervals (sec)
            </h5>
            <div className="grid gap-4 sm:grid-cols-3">
              {COOLDOWN_STAGE_LABELS.map((stageLabel, index) => (
                <Field key={stageLabel} label={stageLabel} description={COOLDOWN_STAGE_DESCRIPTIONS[index]}>
                  <Input
                    type="number"
                    value={digest.metabolism.cooldown_intervals[index] ?? ''}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        const updated = [...digest.metabolism.cooldown_intervals];
                        updated[index] = val;
                        updateDigestMetabolism('cooldown_intervals', updated);
                      }
                    }}
                  />
                </Field>
              ))}
            </div>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Substrate</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max Notes Per Cycle" description="Maximum vault notes to process in a single digest cycle">
              <Input
                type="number"
                value={digest.substrate.max_notes_per_cycle}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestSubstrate('max_notes_per_cycle', val);
                }}
              />
            </Field>
            <Field label="Min Notes For Cycle" description="Minimum new knowledge units needed before a digest cycle runs">
              <Input
                type="number"
                value={digest.substrate.min_notes_for_cycle}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestSubstrate('min_notes_for_cycle', val);
                }}
              />
            </Field>
          </div>
        </div>
      </div>
    </ConfigSection>
  );
}
