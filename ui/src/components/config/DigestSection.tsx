import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Field,
  LLM_PROVIDERS,
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_TIERS,
  COOLDOWN_STAGE_LABELS,
  COOLDOWN_STAGE_DESCRIPTIONS,
  ToggleSwitch,
} from './config-helpers';
import { ModelSelect } from './ModelSelect';

interface DigestSectionProps {
  digest: MycoConfig['digest'];
  intelligence: MycoConfig['intelligence'];
  isDirty: boolean;
  updateDigest: (key: string, value: unknown) => void;
  updateDigestIntelligence: (key: string, value: unknown) => void;
  updateDigestMetabolism: (key: string, value: unknown) => void;
  updateDigestSubstrate: (key: string, value: number) => void;
}

export function DigestSection({
  digest,
  intelligence,
  isDirty,
  updateDigest,
  updateDigestIntelligence,
  updateDigestMetabolism,
  updateDigestSubstrate,
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
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Intelligence</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Override the processor model for digest — use a larger model for better synthesis">
              <Select
                value={digest.intelligence.provider ?? '__null__'}
                onValueChange={(v) =>
                  updateDigestIntelligence('provider', v === '__null__' ? null : v)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__null__">Use main provider</SelectItem>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Model" description="Digest model — quality matters more than speed here">
              <ModelSelect
                provider={digestProvider}
                baseUrl={digestBaseUrl}
                value={digest.intelligence.model ?? ''}
                onChange={(v) => updateDigestIntelligence('model', v || null)}
                placeholder="Use main model"
              />
            </Field>
            <Field label="Context Window" description="How much vault content the digest model can process per cycle">
              <Select
                value={String(digest.intelligence.context_window)}
                onValueChange={(v) =>
                  updateDigestIntelligence('context_window', parseInt(v, 10))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTEXT_WINDOW_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label} ({opt.value.toLocaleString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
          <Field label="Token budgets" description="Pre-computed context sizes available for session injection">
            <div className="flex flex-wrap gap-2">
              {DEFAULT_TIERS.map((tier) => (
                <Badge key={tier} variant="secondary">
                  {tier.toLocaleString()}
                </Badge>
              ))}
            </div>
          </Field>
          <div className="mt-4">
            <Field label="Inject Tier" description="Which tier to inject at session start — larger tiers give agents more context">
              <Select
                value={digest.inject_tier !== null ? String(digest.inject_tier) : '__null__'}
                onValueChange={(v) =>
                  updateDigest('inject_tier', v === '__null__' ? null : parseInt(v, 10))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__null__">None (disabled)</SelectItem>
                  {DEFAULT_TIERS.map((tier) => (
                    <SelectItem key={tier} value={String(tier)}>
                      {tier.toLocaleString()} tokens
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Metabolism</h4>
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
                <Field key={index} label={stageLabel} description={COOLDOWN_STAGE_DESCRIPTIONS[index]}>
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
        </div>
      </div>
    </ConfigSection>
  );
}
