import { useEffect, useState, type ChangeEvent } from 'react';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { Switch } from '../components/ui/switch';
import { FieldShell } from '../components/config/FieldShell';
import { useProjectSelection } from '../hooks/use-project-selection';
import { useGroveConfig, useUpdateGroveConfig, type GroveConfig } from '../hooks/use-grove-config';
import { setAtPath } from '@myco/utils/dot-path';

/* ---------- Helpers ---------- */

const MS_PER_MINUTE = 60_000;

function clampNumber(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function buildPatch(path: string, value: unknown): Partial<GroveConfig> {
  const patch: Record<string, unknown> = {};
  setAtPath(patch, path, value);
  return patch as Partial<GroveConfig>;
}

/* ---------- Field primitives ---------- */

interface FieldRowProps {
  id: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}

/**
 * Grove-tier row wrapper. Description is rendered ABOVE the input on
 * this page (vs System.tsx's helper-below convention), so we pass it
 * as a sibling rather than via FieldShell's `helper` slot.
 */
function FieldRow({ id, label, description, children }: FieldRowProps) {
  return (
    <FieldShell id={id} label={label} scope="grove">
      {description && (
        <p className="font-sans text-xs text-on-surface-variant">{description}</p>
      )}
      {children}
    </FieldShell>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}

function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    const next = clampNumber(parsed, min, max);
    if (next !== value) onCommit(next);
    setDraft(String(next));
  }

  return (
    <FieldRow id={id} label={label} description={description}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step ?? 1}
          disabled={disabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
          onBlur={commit}
          className="w-32 rounded-md border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
        />
        {suffix && (
          <span className="font-sans text-xs text-on-surface-variant">{suffix}</span>
        )}
      </div>
    </FieldRow>
  );
}

interface TextFieldProps {
  id: string;
  label: string;
  description?: string;
  placeholder?: string;
  value: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}

function TextField({
  id,
  label,
  description,
  placeholder,
  value,
  disabled,
  onCommit,
}: TextFieldProps) {
  const [draft, setDraft] = useState<string>(value);
  useEffect(() => { setDraft(value); }, [value]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed !== value) onCommit(trimmed);
  }

  return (
    <FieldRow id={id} label={label} description={description}>
      <input
        id={id}
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onBlur={commit}
        className="w-full rounded-md border border-outline-variant/40 bg-surface-container-low px-2 py-1.5 font-mono text-sm text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
      />
    </FieldRow>
  );
}

interface ToggleFieldProps {
  id: string;
  label: string;
  description?: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

function ToggleField({ id, label, description, value, disabled, onChange }: ToggleFieldProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1.5">
        <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium text-on-surface">
          {label}
          <ScopeBadge scope="grove" />
        </label>
        {description && (
          <p className="font-sans text-xs text-on-surface-variant">{description}</p>
        )}
      </div>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/* ---------- Page ---------- */

export default function GroveSettings() {
  const selection = useProjectSelection();
  const query = useGroveConfig();
  const update = useUpdateGroveConfig();

  if (!selection) {
    return (
      <div className="px-8 py-8 max-w-4xl">
        <PageHeader
          title="Grove Settings"
          subtitle="Settings here apply to every project in the selected Grove."
        />
        <Surface level="low" className="rounded-lg p-6">
          <p className="text-sm text-on-surface-variant">
            Pick a project from the switcher to see Grove Settings.
          </p>
        </Surface>
      </div>
    );
  }

  if (query.isLoading || !query.data) {
    return (
      <PageLoading
        isLoading={query.isLoading}
        error={(query.error as Error) ?? null}
        loadingText="Loading Grove settings..."
      >
        <div />
      </PageLoading>
    );
  }

  const config = query.data.config;
  const groveName = selection.grove.name;
  const saving = update.isPending;

  function patch(path: string, value: unknown) {
    update.mutate(buildPatch(path, value));
  }

  return (
    <div className="px-8 py-8 max-w-4xl space-y-6">
      <PageHeader
        title="Grove Settings"
        subtitle={`Settings here apply to every project in ${groveName}.`}
      />

      {/* Backups */}
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <SectionHeader>Backups</SectionHeader>
        <p className="font-sans text-xs text-on-surface-variant">
          Auto-backup writes to this Grove's backup directory; pruning runs after each backup.
        </p>
        <TextField
          id="backup-dir"
          label="Backup directory"
          description="Use ~/path to expand to the user's home directory."
          placeholder="~/Library/Application Support/myco/backups"
          value={config.backup.dir ?? ''}
          disabled={saving}
          onCommit={(v) => patch('backup.dir', v.length > 0 ? v : null)}
        />
        <NumberField
          id="backup-keep-daily"
          label="Keep daily backups"
          value={config.backup.retention.keep_daily}
          min={1}
          max={365}
          suffix="day(s)"
          disabled={saving}
          onCommit={(v) => patch('backup.retention.keep_daily', v)}
        />
        <NumberField
          id="backup-keep-weekly"
          label="Keep weekly backups"
          value={config.backup.retention.keep_weekly}
          min={0}
          max={52}
          suffix="week(s)"
          disabled={saving}
          onCommit={(v) => patch('backup.retention.keep_weekly', v)}
        />
      </Surface>

      {/* Maintenance */}
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <SectionHeader>Maintenance</SectionHeader>
        <p className="font-sans text-xs text-on-surface-variant">
          Cadences applied to this Grove's database.
        </p>
        <ToggleField
          id="maintenance-auto-optimize"
          label="Auto optimize"
          description="Run SQLite PRAGMA optimize on the configured cadence."
          value={config.maintenance.auto_optimize}
          disabled={saving}
          onChange={(v) => patch('maintenance.auto_optimize', v)}
        />
        <NumberField
          id="maintenance-auto-optimize-interval"
          label="Auto-optimize interval"
          value={config.maintenance.auto_optimize_interval_hours}
          min={1}
          max={720}
          suffix="hours"
          disabled={saving || !config.maintenance.auto_optimize}
          onCommit={(v) => patch('maintenance.auto_optimize_interval_hours', v)}
        />
        <ToggleField
          id="maintenance-auto-integrity"
          label="Auto integrity check"
          description="Run SQLite integrity_check on the configured cadence."
          value={config.maintenance.auto_integrity_check}
          disabled={saving}
          onChange={(v) => patch('maintenance.auto_integrity_check', v)}
        />
        <NumberField
          id="maintenance-auto-integrity-interval"
          label="Integrity-check interval"
          value={config.maintenance.auto_integrity_check_interval_hours}
          min={1}
          max={8760}
          suffix="hours"
          disabled={saving || !config.maintenance.auto_integrity_check}
          onCommit={(v) => patch('maintenance.auto_integrity_check_interval_hours', v)}
        />
      </Surface>

      {/* Embedding */}
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <SectionHeader>Embedding</SectionHeader>
        <ToggleField
          id="embedding-run-in-deep-sleep"
          label="Run in deep sleep"
          description="Keep the embedding-reconcile loop running while the daemon is in deep sleep."
          value={config.embedding.run_in_deep_sleep}
          disabled={saving}
          onChange={(v) => patch('embedding.run_in_deep_sleep', v)}
        />
      </Surface>

      {/* Scheduled tasks */}
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <SectionHeader>Scheduled tasks</SectionHeader>
        <NumberField
          id="agent-active-window-days"
          label="Active project window"
          description="Cap how recently a project must have been active for scheduled tasks to fire. 0 disables cold-project gating."
          value={config.agent.scheduled_tasks_active_window_days}
          min={0}
          max={365}
          suffix="day(s)"
          disabled={saving}
          onCommit={(v) => patch('agent.scheduled_tasks_active_window_days', v)}
        />
      </Surface>

      {/* Sessions */}
      <Surface level="low" className="rounded-lg p-6 space-y-5">
        <SectionHeader>Sessions</SectionHeader>
        <NumberField
          id="daemon-stale-session-threshold"
          label="Stale-session threshold"
          description="Time without new prompts before an active session is auto-completed."
          value={Math.round(config.daemon.stale_session_threshold_ms / MS_PER_MINUTE)}
          min={1}
          max={10_080}
          suffix="minutes"
          disabled={saving}
          onCommit={(v) => patch('daemon.stale_session_threshold_ms', v * MS_PER_MINUTE)}
        />
      </Surface>

      {update.isError && (
        <Surface level="low" className="rounded-lg p-4">
          <p className="text-sm text-tertiary">
            Failed to save: {(update.error as Error)?.message ?? 'unknown error'}
          </p>
        </Surface>
      )}
    </div>
  );
}
