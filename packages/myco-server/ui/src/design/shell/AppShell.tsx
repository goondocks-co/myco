import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Menu as MenuIcon, MoreHorizontal, X, type LucideIcon } from 'lucide-react';
import { useMediaQuery } from '../../hooks/use-media-query';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { IconButton } from '../primitives/Button';

/** Under this width the nav leaves the side for a drawer; the width the nav column takes above it. */
export const COMPACT_QUERY = '(max-width: 1023px)';
/** Under this width the phone's bottom bar carries the main pages. */
export const PHONE_QUERY = '(max-width: 639px)';

interface ShellMenu {
  /** Whether the nav drawer is open. */
  menuOpen: boolean;
  /** Opens the nav drawer, on a screen too narrow for the nav column; focus returns to `opener` when it closes. */
  openMenu: (opener?: HTMLElement | null) => void;
  /** Closes the drawer; a nav item calls it as it navigates. */
  closeMenu: () => void;
}

const ShellMenuContext = createContext<ShellMenu>({ menuOpen: false, openMenu: () => undefined, closeMenu: () => undefined });

/** The shell's drawer controls, for a nav item or a More button. */
export function useShellMenu(): ShellMenu {
  return useContext(ShellMenuContext);
}

export interface AppShellProps {
  /** The nav column's contents. On a narrow screen the same contents fill the drawer. */
  sidebar: ReactNode;
  /** The page's name, shown in the header on a narrow screen. */
  title: string;
  /** The header's actions on a narrow screen: search and the account menu. */
  headerActions?: ReactNode;
  /** The phone's bottom bar. */
  bottomBar?: ReactNode;
  /** Something rendered once beside the frame, such as the search command. */
  overlay?: ReactNode;
  children: ReactNode;
}

/**
 * The dashboard's frame: the nav column beside the page on a wide screen; on a
 * narrower one a header with the nav in a drawer, and on a phone a bottom bar
 * too. The page gets one gutter, and a skip link leads past the nav to it.
 */
export function AppShell({ sidebar, title, headerActions, bottomBar, overlay, children }: AppShellProps) {
  const compact = useMediaQuery(COMPACT_QUERY);
  const phone = useMediaQuery(PHONE_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  // The control that opened the drawer. Nothing here is a Radix trigger, so the drawer hands focus back itself.
  const opener = useRef<HTMLElement | null>(null);
  const location = useLocation();
  useEffect(() => { setMenuOpen(false); }, [location.pathname, location.search]);
  useEffect(() => { if (!compact) setMenuOpen(false); }, [compact]);
  const openMenu = (from?: HTMLElement | null) => {
    opener.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setMenuOpen(true);
  };
  const menu: ShellMenu = { menuOpen, openMenu, closeMenu: () => setMenuOpen(false) };

  return (
    <ShellMenuContext.Provider value={menu}>
      <div className="min-h-screen bg-bg text-ink lg:flex">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-s4 focus:top-s4 focus:z-50 focus:rounded-control focus:bg-surface-1 focus:px-s3 focus:py-s2 focus:t-control focus:text-ink"
        >
          Skip to content
        </a>
        {!compact && (
          <aside data-shell="" aria-label="Navigation" className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col border-r border-line bg-bg">
            {sidebar}
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {compact && (
            <header data-shell="" className="sticky top-0 z-30 flex h-[56px] items-center gap-s2 border-b border-line bg-bg/95 px-gutter backdrop-blur">
              {!phone && (
                <IconButton label="Open navigation" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={(event) => openMenu(event.currentTarget)}>
                  <MenuIcon aria-hidden className="size-[18px]" />
                </IconButton>
              )}
              <span aria-hidden className="grid size-[26px] shrink-0 place-items-center rounded-[7px] bg-primary-bg t-small font-semibold text-primary">M</span>
              <span className="min-w-0 flex-1 truncate t-control font-semibold text-ink">{title}</span>
              <div className="flex shrink-0 items-center gap-s1">{headerActions}</div>
            </header>
          )}
          <main id="main" tabIndex={-1} className={cn('min-w-0 flex-1 p-gutter outline-none', phone && bottomBar != null && 'pb-[calc(var(--gutter)+72px)]')}>
            {children}
          </main>
        </div>
        {compact && (
          <DialogPrimitive.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <DialogPrimitive.Portal>
              <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
              <DialogPrimitive.Content
                data-shell=""
                aria-describedby={undefined}
                onCloseAutoFocus={(event) => {
                  event.preventDefault();
                  if (opener.current?.isConnected) opener.current.focus();
                }}
                className="fixed inset-y-0 left-0 z-50 flex w-[288px] max-w-[calc(100vw-var(--s-12))] flex-col border-r border-line-strong bg-bg shadow-[var(--shadow-overlay)] outline-none"
              >
                <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
                <DialogPrimitive.Close asChild>
                  <IconButton label="Close navigation" size="sm" className="absolute right-s3 top-s4">
                    <X aria-hidden className="size-s4" />
                  </IconButton>
                </DialogPrimitive.Close>
                {sidebar}
              </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
          </DialogPrimitive.Root>
        )}
        {phone && bottomBar}
        {overlay}
      </div>
    </ShellMenuContext.Provider>
  );
}

export interface BottomBarItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  /** Marks the page open whatever the path says. */
  active?: boolean;
}

/** The phone's bottom bar: the main pages, then More for the rest of the nav. */
export function BottomBar({ items }: { items: readonly BottomBarItem[] }) {
  const { openMenu, menuOpen } = useShellMenu();
  const cell = 'flex h-full min-w-0 flex-col items-center justify-center gap-s1 t-meta transition-colors duration-120';
  return (
    <nav
      data-shell=""
      aria-label="Main pages"
      className="fixed inset-x-0 bottom-0 z-30 grid h-[64px] border-t border-line bg-surface-1 pb-[env(safe-area-inset-bottom)]"
      style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
    >
      {items.map(({ to, label, icon: Icon, end, active }) => {
        const body = (
          <>
            <Icon aria-hidden className="size-[20px]" strokeWidth={1.6} />
            <span className="truncate">{label}</span>
          </>
        );
        const tone = (on: boolean) => cn(cell, on ? 'text-primary' : 'text-muted hover:text-ink', focusRing, 'focus-visible:-outline-offset-2');
        return active !== undefined
          ? <Link key={label} to={to} aria-current={active ? 'page' : undefined} className={tone(active)}>{body}</Link>
          : <NavLink key={label} to={to} end={end} className={({ isActive }: { isActive: boolean }) => tone(isActive)}>{body}</NavLink>;
      })}
      <button type="button" onClick={(event) => openMenu(event.currentTarget)} aria-haspopup="dialog" aria-expanded={menuOpen} className={cn(cell, 'text-muted hover:text-ink', focusRing, 'focus-visible:-outline-offset-2')}>
        <MoreHorizontal aria-hidden className="size-[20px]" strokeWidth={1.6} />
        More
      </button>
    </nav>
  );
}
