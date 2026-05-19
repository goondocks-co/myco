import { useEffect, useRef, useState } from 'react';

type ScopeLabel = 'Personal' | 'Project' | 'Grove' | 'Machine';

interface ScopePillProps {
  /** Promote local override to project scope. */
  onPromote: () => void | Promise<void>;
  /** Clear the local override so the project value shines through. */
  onReset: () => void | Promise<void>;
}

interface ScopeBadgeProps {
  scope: 'personal' | 'project' | 'grove' | 'all-groves' | 'machine';
}

const SCOPE_BADGE_LABELS: Record<ScopeBadgeProps['scope'], ScopeLabel | 'Grove' | 'All Groves'> = {
  personal: 'Personal',
  project: 'Project',
  grove: 'Grove',
  'all-groves': 'All Groves',
  machine: 'Machine',
};

const SCOPE_BADGE_TITLES: Record<ScopeBadgeProps['scope'], string> = {
  personal: 'This setting is overridden on this machine',
  project: 'This setting is using the shared project value',
  grove: 'This setting applies to every project in this Grove',
  'all-groves': 'This view aggregates every Grove on this machine',
  machine: 'This setting applies to every Grove on this machine',
};

/*
 * Theme-stable accents per the Phase 7 token map:
 *   personal  → sage   (local overlay you can promote or drop)
 *   project   → ghost-border outline (the shared baseline)
 *   grove     → ochre  (Grove-wide)
 *   all-groves/machine → terracotta (cross-Grove span)
 */
const SCOPE_BADGE_CLASSES: Record<ScopeBadgeProps['scope'], string> = {
  personal: 'border-sage/40 bg-sage/5 text-sage',
  project: 'border-[var(--ghost-border)] bg-surface-container/40 text-on-surface-variant',
  grove: 'border-ochre/40 bg-ochre/5 text-ochre',
  'all-groves': 'border-terracotta/40 bg-terracotta/5 text-terracotta',
  machine: 'border-terracotta/40 bg-terracotta/5 text-terracotta',
};

export function ScopeBadge({ scope }: ScopeBadgeProps) {
  const label = SCOPE_BADGE_LABELS[scope];

  return (
    <span
      title={SCOPE_BADGE_TITLES[scope]}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${SCOPE_BADGE_CLASSES[scope]}`}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${scope === 'personal' ? 'bg-sage' : 'bg-outline-variant/80'}`}
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
 * Closes on Escape or click-outside; menu items get keyboard focus order.
 */
export function ScopePill({ onPromote, onReset }: ScopePillProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="This setting is overridden on this machine"
        className="cursor-pointer transition-colors hover:bg-sage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 rounded-sm"
      >
        <ScopeBadge scope="personal" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-10 mt-1 w-44 rounded-md border border-[var(--ghost-border)] bg-surface-container-high p-1 text-xs shadow-lg"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => { void onPromote(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest focus-visible:outline-none focus-visible:bg-surface-container-highest"
          >
            Save to project
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => { void onReset(); setOpen(false); }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest focus-visible:outline-none focus-visible:bg-surface-container-highest"
          >
            Reset to project
          </button>
        </div>
      )}
    </span>
  );
}
