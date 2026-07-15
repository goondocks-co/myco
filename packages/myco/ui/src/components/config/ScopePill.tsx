import { useEffect, useRef, useState } from 'react';
import { scopePolicyForPath, TIER_LABEL, TIER_TOOLTIP } from '../../config/scope-policy';
import { useIsTeamConfigTarget } from '../../hooks/use-scoped-config';

type BadgeScope = 'personal' | 'project' | 'grove' | 'all-groves' | 'machine' | 'team';

interface ScopeBadgeProps {
  scope: BadgeScope;
}

const SCOPE_BADGE_LABELS: Record<BadgeScope, string> = {
  personal: 'Personal',
  project: 'Project',
  grove: 'Grove',
  'all-groves': 'All Groves',
  machine: 'Machine',
  team: 'Team',
};

const SCOPE_BADGE_TITLES: Record<BadgeScope, string> = {
  personal: 'This setting is overridden on this machine',
  project: 'This setting is using the shared project value',
  grove: 'This setting applies to every project in this Grove',
  'all-groves': 'This view aggregates every Grove on this machine',
  machine: 'This setting applies to every Grove on this machine',
  team: 'This setting applies to everyone on this team',
};

const SCOPE_BADGE_CLASSES: Record<BadgeScope, string> = {
  personal: 'border-sage/40 bg-sage/5 text-sage',
  project: 'border-[var(--ghost-border)] bg-surface-container/40 text-on-surface-variant',
  grove: 'border-ochre/40 bg-ochre/5 text-ochre',
  'all-groves': 'border-terracotta/40 bg-terracotta/5 text-terracotta',
  machine: 'border-terracotta/40 bg-terracotta/5 text-terracotta',
  team: 'border-ochre/40 bg-ochre/5 text-ochre',
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

/** The home tier maps to the matching display badge. `local` is labeled
 *  Personal; the other tiers reuse their own badge. */
const HOME_TIER_BADGE: Record<string, BadgeScope> = {
  machine: 'machine',
  grove: 'grove',
  project: 'project',
  local: 'personal',
};

interface ScopePillProps {
  /** Dotted config path. The scope policy (home + overridableBy) is derived
   *  from the registry — never passed in. */
  path: string;
  /** True when the user already has a Personal (local) override for this field. */
  hasLocalOverride: boolean;
  /** Hard opt-in: write the current effective value to the Personal (local) scope. */
  onSavePersonal: () => void | Promise<void>;
  /** Clear the Personal override so the home-tier value shines through again. */
  onReset: () => void | Promise<void>;
}

/**
 * Compact scope indicator with a click-to-open action menu. Scope is derived
 * from the registry via the field's `path` — the home tier supplies the
 * inactive badge, and the Personal opt-in/reset affordances appear only when
 * the registry lists `local` in `overridableBy`. (A field whose policy does
 * not allow `local` should not render a pill at all; ScopedField shows a
 * static badge instead.)
 *
 * - No local override: shows the home-tier badge with a "Save Personal"
 *   opt-in action that writes the current effective value to local.
 * - Local override present: shows the "Personal" badge with a
 *   "Reset to <home>" action that clears the override.
 *
 * Closes on Escape or click-outside; menu items get keyboard focus order.
 */
export function ScopePill({ path, hasLocalOverride, onSavePersonal, onReset }: ScopePillProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const isTeamTarget = useIsTeamConfigTarget();

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

  // Bound to a served grove: always "Team", never interactive. Grove-homed
  // Personal overrides are refused by design (spec §6) — there is no menu to
  // open, so this renders a plain badge with no click affordance at all.
  if (isTeamTarget) {
    return <ScopeBadge scope="team" />;
  }

  const policy = scopePolicyForPath(path);
  const homeBadge = HOME_TIER_BADGE[policy.home] ?? 'project';
  const activeBadge: BadgeScope = hasLocalOverride ? 'personal' : homeBadge;
  const buttonTitle = hasLocalOverride
    ? SCOPE_BADGE_TITLES.personal
    : (TIER_TOOLTIP[policy.home] ?? SCOPE_BADGE_TITLES[homeBadge]);
  const homeLabel = TIER_LABEL[policy.home] ?? SCOPE_BADGE_LABELS[homeBadge];

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
              Reset to {homeLabel}
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
