import type { MycoConfig } from '../../hooks/use-config';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Field, LLM_PROVIDERS, ToggleSwitch } from './config-helpers';

interface DigestSectionProps {
  digest: MycoConfig['digest'];
  isDirty: boolean;
  updateDigest: (key: string, value: unknown) => void;
  updateDigestIntelligence: (key: string, value: unknown) => void;
  updateDigestMetabolism: (key: string, value: unknown) => void;
  updateDigestSubstrate: (key: string, value: number) => void;
}

export function DigestSection({
  digest,
  isDirty,
  updateDigest,
  updateDigestIntelligence,
  updateDigestMetabolism,
  updateDigestSubstrate,
}: DigestSectionProps) {
  return (
    <ConfigSection
      title="Digest"
      description="Continuous synthesis of vault knowledge into pre-computed context"
      isDirty={isDirty}
    >
      <div className="space-y-6">
        <Field label="Enabled">
          <ToggleSwitch
            checked={digest.enabled}
            onChange={(v) => updateDigest('enabled', v)}
          />
        </Field>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Intelligence</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider" description="Override main LLM provider for digest (null = use main)">
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
            <Field label="Model" description="Override model (null = use main)">
              <Input
                value={digest.intelligence.model ?? ''}
                placeholder="Use main model"
                onChange={(e) =>
                  updateDigestIntelligence('model', e.target.value || null)
                }
              />
            </Field>
            <Field label="Context Window">
              <Input
                type="number"
                value={digest.intelligence.context_window}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestIntelligence('context_window', val);
                }}
              />
            </Field>
            <Field label="Keep Alive" description="Ollama keep-alive duration (e.g. '30m')">
              <Input
                value={digest.intelligence.keep_alive ?? ''}
                placeholder="Provider default"
                onChange={(e) =>
                  updateDigestIntelligence('keep_alive', e.target.value || null)
                }
              />
            </Field>
            <Field label="GPU KV Cache" description="Offload KV cache to GPU">
              <ToggleSwitch
                checked={digest.intelligence.gpu_kv_cache}
                onChange={(v) => updateDigestIntelligence('gpu_kv_cache', v)}
              />
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Tiers</h4>
          <Field label="Token budgets" description="Comma-separated list of tier sizes">
            <Input
              value={digest.tiers.join(', ')}
              onChange={(e) => {
                const tiers = e.target.value
                  .split(',')
                  .map((s) => parseInt(s.trim(), 10))
                  .filter((n) => !isNaN(n) && n > 0);
                if (tiers.length > 0) updateDigest('tiers', tiers);
              }}
            />
          </Field>
          <div className="mt-4">
            <Field label="Inject Tier" description="Which tier to inject into context (null = disabled)">
              <Input
                type="number"
                value={digest.inject_tier ?? ''}
                placeholder="Disabled"
                onChange={(e) => {
                  const val = e.target.value ? parseInt(e.target.value, 10) : null;
                  updateDigest('inject_tier', val !== null && !isNaN(val) ? val : null);
                }}
              />
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Metabolism</h4>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Active Interval (sec)">
              <Input
                type="number"
                value={digest.metabolism.active_interval}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestMetabolism('active_interval', val);
                }}
              />
            </Field>
            <Field label="Dormancy Threshold (sec)">
              <Input
                type="number"
                value={digest.metabolism.dormancy_threshold}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) updateDigestMetabolism('dormancy_threshold', val);
                }}
              />
            </Field>
            <Field
              label="Cooldown Intervals (sec)"
              description="Comma-separated escalating cooldown steps"
            >
              <Input
                value={digest.metabolism.cooldown_intervals.join(', ')}
                onChange={(e) => {
                  const intervals = e.target.value
                    .split(',')
                    .map((s) => parseInt(s.trim(), 10))
                    .filter((n) => !isNaN(n) && n > 0);
                  if (intervals.length > 0) {
                    updateDigestMetabolism('cooldown_intervals', intervals);
                  }
                }}
              />
            </Field>
          </div>
        </div>

        <div>
          <h4 className="mb-3 text-sm font-medium text-muted-foreground">Substrate</h4>
          <Field label="Max Notes Per Cycle">
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
