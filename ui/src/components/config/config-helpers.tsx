import type { ChangeEvent } from 'react';

/* ---------- Constants ---------- */

export const LLM_PROVIDERS = ['ollama', 'lm-studio', 'anthropic'] as const;
export const EMBEDDING_PROVIDERS = ['ollama', 'lm-studio'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const SYNC_MODES = ['git', 'obsidian-sync', 'manual'] as const;

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
