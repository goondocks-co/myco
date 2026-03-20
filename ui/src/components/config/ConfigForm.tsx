import { useState, useCallback, useEffect, type ChangeEvent } from 'react';
import { AlertTriangle, RefreshCw, Save } from 'lucide-react';
import type { MycoConfig } from '../../hooks/use-config';
import { useDaemon } from '../../hooks/use-daemon';
import { useRestart } from '../../hooks/use-restart';
import { ConfigSection } from './ConfigSection';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';

/* ---------- Constants ---------- */

const LLM_PROVIDERS = ['ollama', 'lm-studio', 'anthropic'] as const;
const EMBEDDING_PROVIDERS = ['ollama', 'lm-studio'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const SYNC_MODES = ['git', 'obsidian-sync', 'manual'] as const;

/* ---------- Field helpers ---------- */

interface FieldProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function Field({ label, description, children }: FieldProps) {
  return (
    <div className="grid gap-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        checked ? 'bg-primary' : 'bg-muted'
      }`}
    >
      <span
        className={`pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

/* ---------- Dirty detection ---------- */

function isDirty(current: unknown, original: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(original);
}

/* ---------- ConfigForm ---------- */

interface ConfigFormProps {
  config: MycoConfig;
  onSave: (config: MycoConfig) => Promise<unknown>;
  isSaving: boolean;
}

export function ConfigForm({ config, onSave, isSaving }: ConfigFormProps) {
  const [form, setForm] = useState<MycoConfig>(config);
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [savedConfigHash, setSavedConfigHash] = useState<string | null>(null);

  const { data: stats } = useDaemon();
  const { restart, isRestarting } = useRestart();

  // Reset form when server config changes (e.g. after refetch)
  useEffect(() => {
    setForm(config);
  }, [config]);

  const runningConfigHash = stats?.daemon.config_hash ?? null;
  const needsRestart = savedConfigHash !== null && savedConfigHash !== runningConfigHash;

  const formDirty = isDirty(form, config);

  // Section-level dirty checks
  const intelligenceDirty = isDirty(form.intelligence, config.intelligence);
  const digestDirty = isDirty(form.digest, config.digest);
  const captureDirty = isDirty(form.capture, config.capture);
  const contextDirty = isDirty(form.context, config.context);
  const daemonDirty = isDirty(form.daemon, config.daemon);
  const teamDirty = isDirty(form.team, config.team);

  /* -- Updaters -- */

  const updateLlm = useCallback(
    (key: string, value: string | number) =>
      setForm((prev) => ({
        ...prev,
        intelligence: {
          ...prev.intelligence,
          llm: { ...prev.intelligence.llm, [key]: value },
        },
      })),
    [],
  );

  const updateEmbedding = useCallback(
    (key: string, value: string) =>
      setForm((prev) => ({
        ...prev,
        intelligence: {
          ...prev.intelligence,
          embedding: { ...prev.intelligence.embedding, [key]: value },
        },
      })),
    [],
  );

  const updateDigest = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: { ...prev.digest, [key]: value },
      })),
    [],
  );

  const updateDigestIntelligence = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: {
          ...prev.digest,
          intelligence: { ...prev.digest.intelligence, [key]: value },
        },
      })),
    [],
  );

  const updateDigestMetabolism = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        digest: {
          ...prev.digest,
          metabolism: { ...prev.digest.metabolism, [key]: value },
        },
      })),
    [],
  );

  const updateCapture = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        capture: { ...prev.capture, [key]: value },
      })),
    [],
  );

  const updateContext = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        context: { ...prev.context, [key]: value },
      })),
    [],
  );

  const updateContextLayer = useCallback(
    (key: string, value: number) =>
      setForm((prev) => ({
        ...prev,
        context: {
          ...prev.context,
          layers: { ...prev.context.layers, [key]: value },
        },
      })),
    [],
  );

  const updateDaemon = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        daemon: { ...prev.daemon, [key]: value },
      })),
    [],
  );

  const updateTeam = useCallback(
    (key: string, value: unknown) =>
      setForm((prev) => ({
        ...prev,
        team: { ...prev.team, [key]: value },
      })),
    [],
  );

  const handleSave = async () => {
    const saved = await onSave(form);
    // Track the hash so we can detect restart-needed
    if (runningConfigHash) {
      setSavedConfigHash(runningConfigHash);
    }
    setShowRestartDialog(true);
    return saved;
  };

  const handleRestart = async () => {
    setShowRestartDialog(false);
    await restart(true);
  };

  const numChange = (fn: (key: string, value: number) => void, key: string) =>
    (e: ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) fn(key, val);
    };

  const strChange = (fn: (key: string, value: string) => void, key: string) =>
    (e: ChangeEvent<HTMLInputElement>) => fn(key, e.target.value);

  return (
    <div className="space-y-4">
      {/* Restart-pending banner */}
      {needsRestart && (
        <div className="flex items-center gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-500" />
          <span className="flex-1 text-sm text-yellow-700 dark:text-yellow-400">
            Configuration changed — restart required for changes to take effect
          </span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-yellow-500/50 text-yellow-700 hover:bg-yellow-500/10 dark:text-yellow-400"
            onClick={handleRestart}
            disabled={isRestarting}
          >
            {isRestarting ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Restart Now
          </Button>
        </div>
      )}

      {/* 1. Intelligence */}
      <ConfigSection
        title="Intelligence"
        description="LLM and embedding provider configuration"
        isDirty={intelligenceDirty}
        defaultOpen
      >
        <div className="space-y-6">
          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">LLM</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Select
                  value={form.intelligence.llm.provider}
                  onValueChange={(v) => updateLlm('provider', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LLM_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <Input
                  value={form.intelligence.llm.model}
                  onChange={strChange(updateLlm, 'model')}
                />
              </Field>
              <Field label="Context Window">
                <Input
                  type="number"
                  value={form.intelligence.llm.context_window}
                  onChange={numChange(updateLlm, 'context_window')}
                />
              </Field>
              <Field label="Max Tokens">
                <Input
                  type="number"
                  value={form.intelligence.llm.max_tokens}
                  onChange={numChange(updateLlm, 'max_tokens')}
                />
              </Field>
            </div>
          </div>
          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Embedding</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Select
                  value={form.intelligence.embedding.provider}
                  onValueChange={(v) => updateEmbedding('provider', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMBEDDING_PROVIDERS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Model">
                <Input
                  value={form.intelligence.embedding.model}
                  onChange={strChange(updateEmbedding, 'model')}
                />
              </Field>
            </div>
          </div>
        </div>
      </ConfigSection>

      {/* 2. Digest */}
      <ConfigSection
        title="Digest"
        description="Continuous synthesis of vault knowledge into pre-computed context"
        isDirty={digestDirty}
      >
        <div className="space-y-6">
          <Field label="Enabled">
            <ToggleSwitch
              checked={form.digest.enabled}
              onChange={(v) => updateDigest('enabled', v)}
            />
          </Field>

          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Intelligence</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider" description="Override main LLM provider for digest (null = use main)">
                <Select
                  value={form.digest.intelligence.provider ?? '__null__'}
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
                  value={form.digest.intelligence.model ?? ''}
                  placeholder="Use main model"
                  onChange={(e) =>
                    updateDigestIntelligence('model', e.target.value || null)
                  }
                />
              </Field>
              <Field label="Context Window">
                <Input
                  type="number"
                  value={form.digest.intelligence.context_window}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) updateDigestIntelligence('context_window', val);
                  }}
                />
              </Field>
              <Field label="Keep Alive" description="Ollama keep-alive duration (e.g. '30m')">
                <Input
                  value={form.digest.intelligence.keep_alive ?? ''}
                  placeholder="Provider default"
                  onChange={(e) =>
                    updateDigestIntelligence('keep_alive', e.target.value || null)
                  }
                />
              </Field>
              <Field label="GPU KV Cache" description="Offload KV cache to GPU">
                <ToggleSwitch
                  checked={form.digest.intelligence.gpu_kv_cache}
                  onChange={(v) => updateDigestIntelligence('gpu_kv_cache', v)}
                />
              </Field>
            </div>
          </div>

          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Tiers</h4>
            <Field label="Token budgets" description="Comma-separated list of tier sizes">
              <Input
                value={form.digest.tiers.join(', ')}
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
                  value={form.digest.inject_tier ?? ''}
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
                  value={form.digest.metabolism.active_interval}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val)) updateDigestMetabolism('active_interval', val);
                  }}
                />
              </Field>
              <Field label="Dormancy Threshold (sec)">
                <Input
                  type="number"
                  value={form.digest.metabolism.dormancy_threshold}
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
                  value={form.digest.metabolism.cooldown_intervals.join(', ')}
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
                value={form.digest.substrate.max_notes_per_cycle}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  if (!isNaN(val)) {
                    setForm((prev) => ({
                      ...prev,
                      digest: {
                        ...prev.digest,
                        substrate: { ...prev.digest.substrate, max_notes_per_cycle: val },
                      },
                    }));
                  }
                }}
              />
            </Field>
          </div>
        </div>
      </ConfigSection>

      {/* 3. Capture */}
      <ConfigSection
        title="Capture"
        description="Event buffering and token budgets for LLM processing"
        isDirty={captureDirty}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Buffer Max Events">
            <Input
              type="number"
              value={form.capture.buffer_max_events}
              onChange={numChange(updateCapture, 'buffer_max_events')}
            />
          </Field>
          <Field label="Extraction Max Tokens">
            <Input
              type="number"
              value={form.capture.extraction_max_tokens}
              onChange={numChange(updateCapture, 'extraction_max_tokens')}
            />
          </Field>
          <Field label="Summary Max Tokens">
            <Input
              type="number"
              value={form.capture.summary_max_tokens}
              onChange={numChange(updateCapture, 'summary_max_tokens')}
            />
          </Field>
          <Field label="Title Max Tokens">
            <Input
              type="number"
              value={form.capture.title_max_tokens}
              onChange={numChange(updateCapture, 'title_max_tokens')}
            />
          </Field>
          <Field label="Classification Max Tokens">
            <Input
              type="number"
              value={form.capture.classification_max_tokens}
              onChange={numChange(updateCapture, 'classification_max_tokens')}
            />
          </Field>
        </div>
      </ConfigSection>

      {/* 4. Context */}
      <ConfigSection
        title="Context"
        description="Context injection token budget and layer allocations"
        isDirty={contextDirty}
      >
        <div className="space-y-4">
          <Field label="Max Tokens">
            <Input
              type="number"
              value={form.context.max_tokens}
              onChange={numChange(updateContext, 'max_tokens')}
            />
          </Field>
          <div>
            <h4 className="mb-3 text-sm font-medium text-muted-foreground">Layer Allocations</h4>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Plans">
                <Input
                  type="number"
                  value={form.context.layers.plans}
                  onChange={numChange(updateContextLayer, 'plans')}
                />
              </Field>
              <Field label="Sessions">
                <Input
                  type="number"
                  value={form.context.layers.sessions}
                  onChange={numChange(updateContextLayer, 'sessions')}
                />
              </Field>
              <Field label="Spores">
                <Input
                  type="number"
                  value={form.context.layers.spores}
                  onChange={numChange(updateContextLayer, 'spores')}
                />
              </Field>
              <Field label="Team">
                <Input
                  type="number"
                  value={form.context.layers.team}
                  onChange={numChange(updateContextLayer, 'team')}
                />
              </Field>
            </div>
          </div>
        </div>
      </ConfigSection>

      {/* 5. Daemon */}
      <ConfigSection
        title="Daemon"
        description="Daemon process settings"
        isDirty={daemonDirty}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Port" description="Leave empty for auto-assigned port">
            <Input
              type="number"
              value={form.daemon.port ?? ''}
              placeholder="Auto"
              onChange={(e) => {
                const val = e.target.value ? parseInt(e.target.value, 10) : null;
                updateDaemon('port', val !== null && !isNaN(val) ? val : null);
              }}
            />
          </Field>
          <Field label="Log Level">
            <Select
              value={form.daemon.log_level}
              onValueChange={(v) => updateDaemon('log_level', v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOG_LEVELS.map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Grace Period (sec)" description="Seconds to wait before shutting down idle daemon">
            <Input
              type="number"
              value={form.daemon.grace_period}
              onChange={numChange(updateDaemon as (k: string, v: number) => void, 'grace_period')}
            />
          </Field>
          <Field label="Max Log Size (bytes)">
            <Input
              type="number"
              value={form.daemon.max_log_size}
              onChange={numChange(updateDaemon as (k: string, v: number) => void, 'max_log_size')}
            />
          </Field>
        </div>
      </ConfigSection>

      {/* 6. Team */}
      <ConfigSection
        title="Team"
        description="Multi-user collaboration settings"
        isDirty={teamDirty}
      >
        <div className="space-y-4">
          <Field label="Enabled">
            <ToggleSwitch
              checked={form.team.enabled}
              onChange={(v) => updateTeam('enabled', v)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="User Name">
              <Input
                value={form.team.user}
                onChange={(e) => updateTeam('user', e.target.value)}
              />
            </Field>
            <Field label="Sync Mode">
              <Select
                value={form.team.sync}
                onValueChange={(v) => updateTeam('sync', v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SYNC_MODES.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </div>
      </ConfigSection>

      {/* Save button */}
      <div className="flex items-center justify-end gap-3 pt-2">
        {formDirty && (
          <span className="text-sm text-muted-foreground">Unsaved changes</span>
        )}
        <Button
          onClick={handleSave}
          disabled={!formDirty || isSaving}
          className="gap-2"
        >
          {isSaving ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      {/* Restart dialog */}
      <Dialog open={showRestartDialog} onOpenChange={setShowRestartDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configuration Saved</DialogTitle>
            <DialogDescription>
              Changes have been saved to disk. Some settings require a daemon restart to take effect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRestartDialog(false)}>
              Later
            </Button>
            <Button
              onClick={handleRestart}
              disabled={isRestarting}
              className="gap-2"
            >
              {isRestarting ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {isRestarting ? 'Restarting...' : 'Restart Now'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
