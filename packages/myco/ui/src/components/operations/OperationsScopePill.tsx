import { cn } from '../../lib/cn';

/**
 * Scope dispatch values used by Operations sections to control which slice of
 * the multi-tenant daemon a panel reads from and dispatches actions against.
 *
 * - `project`    — the active project only (default for multi-scoped sections)
 * - `grove`      — every project in the active Grove
 * - `all-groves` — aggregates every Grove on this machine
 */
export type OperationsScope = 'project' | 'grove' | 'all-groves';

const ALL_SCOPES: ReadonlyArray<OperationsScope> = ['project', 'grove', 'all-groves'];

const SCOPE_LABELS: Record<OperationsScope, string> = {
  project: 'Project',
  grove: 'Grove',
  'all-groves': 'All Groves',
};

const SCOPE_TITLES: Record<OperationsScope, string> = {
  project: 'Operate on the active project only',
  grove: 'Operate on every project in this Grove',
  'all-groves': 'Operate across every Grove on this machine',
};

const ACTIVE_CLASSES: Record<OperationsScope, string> = {
  project: 'border-outline-variant/30 bg-on-surface-variant/15 text-on-surface',
  grove: 'border-secondary/50 bg-secondary/10 text-secondary',
  'all-groves': 'border-tertiary/50 bg-tertiary/10 text-tertiary',
};

const INACTIVE_CLASSES: Record<OperationsScope, string> = {
  project: 'border-outline-variant/20 text-on-surface-variant hover:bg-on-surface-variant/5',
  grove: 'border-outline-variant/20 text-on-surface-variant hover:bg-secondary/5',
  'all-groves': 'border-outline-variant/20 text-on-surface-variant hover:bg-tertiary/5',
};

export interface OperationsScopePillProps {
  value: OperationsScope;
  onChange: (next: OperationsScope) => void;
  /** Hide pill choices not supported by this section. Defaults to all three. */
  available?: ReadonlyArray<OperationsScope>;
  /** Optional helper line below the pill explaining the current scope. */
  helperText?: string;
}

export function OperationsScopePill({
  value,
  onChange,
  available = ALL_SCOPES,
  helperText,
}: OperationsScopePillProps) {
  const visible = ALL_SCOPES.filter((s) => available.includes(s));
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Operation scope" className="inline-flex items-center gap-1">
        {visible.map((scope) => {
          const active = value === scope;
          return (
            <button
              key={scope}
              type="button"
              onClick={() => onChange(scope)}
              title={SCOPE_TITLES[scope]}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider transition-colors',
                active ? ACTIVE_CLASSES[scope] : INACTIVE_CLASSES[scope],
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  active && scope === 'grove' && 'bg-secondary',
                  active && scope === 'all-groves' && 'bg-tertiary',
                  active && scope === 'project' && 'bg-on-surface-variant',
                  !active && 'bg-outline-variant/60',
                )}
                aria-hidden
              />
              {SCOPE_LABELS[scope]}
            </button>
          );
        })}
      </div>
      {helperText && (
        <p className="font-sans text-xs text-on-surface-variant">{helperText}</p>
      )}
    </div>
  );
}
