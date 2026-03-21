import type { ChangeEvent } from 'react';

/* ---------- Constants ---------- */

export const LLM_PROVIDERS = ['ollama', 'lm-studio', 'anthropic', 'openai-compatible'] as const;
export const EMBEDDING_PROVIDERS = ['ollama', 'lm-studio', 'openai-compatible'] as const;

/** Default base URLs per provider — used to reset base_url when provider changes. */
export const PROVIDER_DEFAULT_URLS: Record<string, string | undefined> = {
  ollama: 'http://localhost:11434',
  'lm-studio': 'http://localhost:1234',
  'openai-compatible': undefined, // User must provide
};
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const SYNC_MODES = ['git', 'obsidian-sync', 'manual'] as const;

export const CONTEXT_WINDOW_OPTIONS = [
  { value: 2048, label: '2K' },
  { value: 4096, label: '4K' },
  { value: 8192, label: '8K' },
  { value: 16384, label: '16K' },
  { value: 32768, label: '32K' },
  { value: 65536, label: '64K' },
  { value: 131072, label: '128K' },
] as const;

export const DEFAULT_TIERS = [1500, 3000, 5000, 10000] as const;

export const COOLDOWN_STAGE_LABELS = [
  'Stage 1 (warm)',
  'Stage 2 (cooling)',
  'Stage 3 (cold)',
] as const;

export const COOLDOWN_STAGE_DESCRIPTIONS = [
  'Seconds between cycles after initial activity subsides',
  'Seconds between cycles as activity continues to drop',
  'Seconds between cycles just before dormancy',
] as const;

/* ---------- Field ---------- */

interface FieldProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

export function Field({ label, description, children }: FieldProps) {
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

/* ---------- ToggleSwitch ---------- */

export function ToggleSwitch({
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

/* ---------- NativeSelect ---------- */

interface NativeSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }> | ReadonlyArray<string>;
  disabled?: boolean;
  className?: string;
}

export function NativeSelect({ value, onChange, options, disabled, className }: NativeSelectProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={`w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 ${className ?? ''}`}
    >
      {options.map((opt) => {
        const val = typeof opt === 'string' ? opt : opt.value;
        const label = typeof opt === 'string' ? opt : opt.label;
        return <option key={val} value={val}>{label}</option>;
      })}
    </select>
  );
}

/* ---------- Change helpers ---------- */

export const numChange =
  (fn: (key: string, value: number) => void, key: string) =>
  (e: ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) fn(key, val);
  };

export const strChange =
  (fn: (key: string, value: string) => void, key: string) =>
  (e: ChangeEvent<HTMLInputElement>) =>
    fn(key, e.target.value);

/* ---------- Dirty detection ---------- */

export function isDirty(current: unknown, original: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(original);
}
