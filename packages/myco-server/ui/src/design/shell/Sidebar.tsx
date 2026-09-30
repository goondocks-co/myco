import { type ReactNode } from 'react';
import { Link as RouterLink, NavLink } from 'react-router-dom';
import { Search, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { Kbd } from '../primitives/Chip';

/** The brand at the top of the nav: the mark and the word, leading home. */
export function Brand({ to = '/', compact = false, onNavigate }: { to?: string; compact?: boolean; onNavigate?: () => void }) {
  return (
    <RouterLink
      to={to}
      onClick={onNavigate}
      aria-label="Myco home"
      className={cn('inline-flex min-w-0 items-center gap-s3 rounded-control px-s2 py-s1 text-ink', focusRing)}
    >
      <span aria-hidden className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary-bg t-small font-semibold not-italic text-primary">M</span>
      {!compact && <span aria-hidden className="font-serif text-[22px] font-semibold italic leading-none">Myco</span>}
    </RouterLink>
  );
}

export interface NavItemProps {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Active only on this exact path, not the paths under it. */
  end?: boolean;
  /** A count or chip at the right edge. */
  badge?: ReactNode;
  onNavigate?: () => void;
}

const itemClass = (active: boolean) => cn(
  'flex h-control items-center gap-s3 rounded-control px-s3 t-control transition-colors duration-120',
  active ? 'bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  focusRing,
);

/** One page in the nav; the page open now is marked current. */
export function NavItem({ to, label, icon: Icon, end = false, badge, onNavigate }: NavItemProps) {
  return (
    <NavLink to={to} end={end} onClick={onNavigate} className={({ isActive }) => itemClass(isActive)}>
      <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.6} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && <span className="ml-auto shrink-0 t-meta text-faint">{badge}</span>}
    </NavLink>
  );
}

export interface NavSectionProps {
  /** Names the landmark for assistive technology. */
  label: string;
  /** A visible kicker above the items. */
  heading?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A labelled group of nav items: one `nav` landmark. */
export function NavSection({ label, heading, children, className }: NavSectionProps) {
  return (
    <nav aria-label={label} className={cn('flex flex-col gap-[2px]', className)}>
      {heading != null && <div className="flex items-center justify-between px-s3 pb-s2 t-kicker text-faint">{heading}</div>}
      {children}
    </nav>
  );
}

/** The search field in the nav: it opens the search command, and says which key does too. */
export function SearchTrigger({ onOpen, label = 'Search' }: { onOpen: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        'flex h-control w-full min-w-0 items-center gap-s3 rounded-control border border-line-strong bg-surface-1 px-s3 t-control text-muted',
        'transition-colors duration-120 hover:border-faint hover:text-ink-2',
        focusRing,
      )}
    >
      <Search aria-hidden className="size-s4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <Kbd aria-hidden className="hidden sm:inline-flex">⌘K</Kbd>
    </button>
  );
}

export interface SidebarProps {
  /** The brand, the search field and the pages, top down. */
  top: ReactNode;
  /** The project filter, between the pages and the foot. */
  middle?: ReactNode;
  /** The admin pages, at the foot of the scrolling part; left out for a member. */
  foot?: ReactNode;
  /** The account menu, pinned to the bottom. */
  account: ReactNode;
  className?: string;
}

/**
 * The nav column: brand, search and pages at the top, the project filter, then
 * the admin foot. The account stays pinned to the bottom while the rest
 * scrolls, so it is in reach on a short screen.
 */
export function Sidebar({ top, middle, foot, account, className }: SidebarProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex min-h-0 flex-1 flex-col gap-s4 overflow-y-auto px-s3 pb-s3 pt-s4">
        <div className="flex flex-col gap-s3">{top}</div>
        {middle}
        {foot != null && <div className="mt-auto border-t border-line pt-s3">{foot}</div>}
      </div>
      <div className="shrink-0 border-t border-line px-s3 py-s2">{account}</div>
    </div>
  );
}
