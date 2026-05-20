import { useEffect, useRef, useState } from 'react';

type ScopeLabel = 'Personal' | 'Project' | 'Grove' | 'Machine';

/**
 * Local-default mode (defaultScope='local'): a local override already exists.
 * Offers promote (→ project) and reset (→ project) actions.
 */
interface ScopePillLocalDefaultProps {
  mode: 'local-default';
  /** Copy current effective value into project scope, then clear local override. */
  onPromote: () => void | Promise<void>;
  /** Clear the local override so the project value shines through. */
  onReset: () => void | Promise<void>;
}

/**
 * Shared-default mode (defaultScope='grove'|'project'|'machine'): the field's
 * canonical home is a shared tier. The pill renders always:
 * - No local override: shows the default-tier badge with a "Save Personal"
 *   action — the hard opt-in that writes the current effective value to local.
 * - Local override present: shows "Personal" badge with a "Reset" action that
 *   clears the local override so the shared-tier value takes effect again.
 */
interface ScopePillSharedDefaultProps {
  mode: 'shared-default';
  /** True when the user already has a local override for this field. */
  hasLocalOverride: boolean;
  /** The badge to show when no local override is active (e.g. 'grove', 'project'). */
  defaultScopeBadge: ScopeBadgeProps['scope'];
  /** Hard opt-in: write the current effective value to local scope. */
  onSavePersonal: () => void | Promise<void>;
  /** Clear the local override so the shared-tier value shines through. */
  onReset: () => void | Promise<void>;
}

type ScopePillProps = ScopePillLocalDefaultProps | ScopePillSharedDefaultProps;

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
 * Compact scope indicator with a click-to-open action menu.
 *
 * Two modes:
 * - `local-default`: the field has an active local override of a locally-
 *   defaulted field. Shows "Personal" badge with promote+reset actions.
 * - `shared-default`: the field's canonical tier is grove/project/machine.
 *   When no local override: shows the shared-tier badge with a "Save Personal"
 *   opt-in action. When a local override exists: shows "Personal" badge with
 *   a "Reset" action to restore the shared-tier value.
 *
 * Closes on Escape or click-outside; menu items get keyboard focus order.
 */
export function ScopePill(props: ScopePillProps) {
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

  if (props.mode === 'local-default') {
    const { onPromote, onReset } = props;
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

  // shared-default mode
  const { hasLocalOverride, defaultScopeBadge, onSavePersonal, onReset } = props;
  const activeBadge: ScopeBadgeProps['scope'] = hasLocalOverride ? 'personal' : defaultScopeBadge;
  const buttonTitle = hasLocalOverride
    ? 'This setting is overridden on this machine'
    : SCOPE_BADGE_TITLES[defaultScopeBadge];

  return (
    <span ref={wrapperRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={buttonTitle}
        className="cursor-pointer transition-colors hover:bg-sage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 rounded-sm"
      >
        <ScopeBadge scope={activeBadge} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-10 mt-1 w-44 rounded-md border border-[var(--ghost-border)] bg-surface-container-high p-1 text-xs shadow-lg"
        >
          {hasLocalOverride ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => { void onReset(); setOpen(false); }}
              className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest focus-visible:outline-none focus-visible:bg-surface-container-highest"
            >
              Reset to {SCOPE_BADGE_LABELS[defaultScopeBadge]}
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => { void onSavePersonal(); setOpen(false); }}
              className="block w-full rounded px-2 py-1 text-left hover:bg-surface-container-highest focus-visible:outline-none focus-visible:bg-surface-container-highest"
            >
              Save Personal
            </button>
          )}
        </div>
      )}
    </span>
  );
}
