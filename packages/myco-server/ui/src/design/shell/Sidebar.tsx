import { type ReactNode } from 'react';
import { Link as RouterLink, NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Search, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { IconButton } from '../primitives/Button';
import { Kbd } from '../primitives/Chip';
import { useNavRail } from './AppShell';

/** The brand at the top of the nav: the mark and the word, leading home. */
export function Brand({ to = '/', compact = false, onNavigate }: { to?: string; compact?: boolean; onNavigate?: () => void }) {
  return (
    <RouterLink
      to={to}
      onClick={onNavigate}
      aria-label="Myco home"
      className={cn('inline-flex min-h-tap min-w-0 items-center gap-s3 rounded-control px-s2 py-s1 text-ink', focusRing)}
    >
      <span aria-hidden className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary-bg t-small font-semibold not-italic text-primary before:content-['M']" />
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
  /** Marks the page open whatever the path says: for a page whose records live at paths outside its own. */
  active?: boolean;
  /** A count or chip at the right edge. */
  badge?: ReactNode;
  onNavigate?: () => void;
}

const itemClass = (active: boolean, rail: boolean) => cn(
  'flex h-control items-center rounded-control t-control transition-colors duration-120',
  rail ? 'relative justify-center' : 'gap-s3 px-s3',
  active ? 'bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  focusRing,
);

/** One page in the nav; the page open now is marked current. */
export function NavItem({ to, label, icon: Icon, end = false, active, badge, onNavigate }: NavItemProps) {
  const { collapsed } = useNavRail();
  const body = (
    <>
      <Icon aria-hidden className="size-[18px] shrink-0" strokeWidth={1.6} />
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{label}</span>
      {badge != null && (
        <span className={collapsed ? 'absolute -right-s1 -top-s1 t-meta' : 'ml-auto shrink-0 t-meta text-faint'}>{badge}</span>
      )}
    </>
  );
  const title = collapsed ? label : undefined;
  if (active !== undefined) {
    return <RouterLink to={to} onClick={onNavigate} title={title} aria-current={active ? 'page' : undefined} className={itemClass(active, collapsed)}>{body}</RouterLink>;
  }
  return (
    <NavLink to={to} end={end} onClick={onNavigate} title={title} className={({ isActive }: { isActive: boolean }) => itemClass(isActive, collapsed)}>
      {body}
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
  const { collapsed } = useNavRail();
  return (
    <nav aria-label={label} className={cn('flex flex-col gap-[2px]', className)}>
      {heading != null && !collapsed && <div className="flex items-center justify-between px-s3 pb-s2 t-kicker text-faint">{heading}</div>}
      {children}
    </nav>
  );
}

/** The search field in the nav: it opens the search command, and says which key does too. */
export function SearchTrigger({ onOpen, label = 'Search' }: { onOpen: () => void; label?: string }) {
  const { collapsed } = useNavRail();
  if (collapsed) {
    return (
      <IconButton label={label} variant="secondary" onClick={onOpen} aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" className="w-full">
        <Search aria-hidden className="size-s4" />
      </IconButton>
    );
  }
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

/** The control in the nav column that narrows it to the icon rail and widens it again. It renders nowhere the nav cannot collapse, such as the drawer. */
export function NavCollapseToggle() {
  const { collapsed, toggle } = useNavRail();
  if (toggle === null) return null;
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <IconButton label={collapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!collapsed} onClick={toggle}>
      <Icon aria-hidden className="size-[18px]" />
    </IconButton>
  );
}

export interface SidebarProps {
  /** The brand, the search field and the pages, top down. */
  top: ReactNode;
  /** The admin pages, pinned at the foot; left out for a member. */
  foot?: ReactNode;
  /** The account menu, pinned to the bottom. */
  account: ReactNode;
  className?: string;
}

/**
 * The nav column: brand, search and pages at the top, the admin foot and the
 * account at the bottom. It lists pages only; which projects a page shows is
 * said in the page's own header. On a screen too short for it, the column
 * scrolls.
 */
export function Sidebar({ top, foot, account, className }: SidebarProps) {
  const { collapsed } = useNavRail();
  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-y-auto', className)}>
      <div className="flex shrink-0 flex-col gap-s3 px-s3 pb-s3 pt-s4">{top}</div>
      <div className="flex-1" />
      {foot != null && <div className="shrink-0 border-t border-line px-s3 py-s2">{foot}</div>}
      <div className={cn('shrink-0 border-t border-line px-s3 py-s2', collapsed && 'flex justify-center')}>{account}</div>
    </div>
  );
}

export interface NavGroupProps {
  /** The group's own page, which heads it. */
  item: NavItemProps;
  /** The pages folded under it, listed while any page of the group is open. */
  items: readonly NavItemProps[];
  /** Whether a page of the group is open. */
  open: boolean;
}

/** A page with the pages folded under it: the head always, the rest while the group is open. */
export function NavGroup({ item, items, open }: NavGroupProps) {
  const { collapsed } = useNavRail();
  return (
    <div className="flex flex-col gap-[2px]" data-nav-group="">
      <NavItem {...item} end />
      {open && !collapsed && (
        <div className="ml-[21px] flex flex-col gap-[2px] border-l border-line pl-s2">
          {items.map((child) => (
            <NavLink
              key={child.to}
              to={child.to}
              onClick={child.onNavigate}
              className={({ isActive }: { isActive: boolean }) => cn(
                'flex h-control-sm items-center rounded-control px-s2 t-small transition-colors duration-120',
                isActive ? 'bg-surface-3 font-medium text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink',
                focusRing,
              )}
            >
              {child.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
