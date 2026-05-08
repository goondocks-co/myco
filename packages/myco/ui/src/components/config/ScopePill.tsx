import { useState } from 'react';

type ScopeLabel = 'Personal' | 'Project' | 'Grove';

interface ScopePillProps {
  /** Promote local override to project scope. */
  onPromote: () => void | Promise<void>;
  /** Clear the local override so the project value shines through. */
  onReset: () => void | Promise<void>;
}

interface ScopeBadgeProps {
  scope: 'personal' | 'project' | 'grove' | 'all-groves';
}

const SCOPE_BADGE_LABELS: Record<ScopeBadgeProps['scope'], ScopeLabel | 'Grove' | 'All Groves'> = {
  personal: 'Personal',
  project: 'Project',
  grove: 'Grove',
  'all-groves': 'All Groves',
};

const SCOPE_BADGE_TITLES: Record<ScopeBadgeProps['scope'], string> = {
  personal: 'This setting is overridden on this machine',
  project: 'This setting is using the shared project value',
  grove: 'This setting applies to every project in this Grove',
  'all-groves': 'This view aggregates every Grove on this machine',
};

const SCOPE_BADGE_CLASSES: Record<ScopeBadgeProps['scope'], string> = {
  personal: 'border-primary/40 bg-primary/5 text-primary',
  project: 'border-outline-variant/30 bg-surface-container-high/40 text-on-surface-variant',
  grove: 'border-secondary/40 bg-secondary/5 text-secondary',
  'all-groves': 'border-tertiary/40 bg-tertiary/5 text-tertiary',
};

export function ScopeBadge({ scope }: ScopeBadgeProps) {
  const label = SCOPE_BADGE_LABELS[scope];

  return (
    <span
      title={SCOPE_BADGE_TITLES[scope]}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${SCOPE_BADGE_CLASSES[scope]}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${scope === 'personal' ? 'bg-primary' : 'bg-outline-variant/80'}`}
        aria-hidden
      />
      {label}
    </span>
  );
}

/**
 * Compact "Personal" indicator with a click-to-open menu offering promote
 * (Save to project) and reset (Reset to project) actions. Used wherever a
 * scoped field has an active local override — ScopedField renders one
 * automatically; custom card components render this directly when they
 * need per-row scope affordances.
 *
 * Visually distinct from status badges: outlined + accent-colored so it
 * reads as an interactive control, not a passive label.
 */
export function ScopePill({ onPromote, onReset }: ScopePillProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="This setting is overridden on this machine"
        className="cursor-pointer transition-colors hover:bg-primary/10"
      >
        <ScopeBadge scope="personal" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 w-44 rounded-md border border-outline-variant/20 bg-surface-container-high p-1 text-xs shadow-lg">
          <button
            type="button"
            onClick={() => { void onPromote(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest"
          >
            Save to project
          </button>
          <button
            type="button"
            onClick={() => { void onReset(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest"
          >
            Reset to project
          </button>
        </div>
      )}
    </span>
  );
}
