import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CONFIG_FOCUS_FIELD_PARAM,
  CONFIG_FOCUS_SECTION_PARAM,
  configFieldId,
} from '@myco/config/focus';
import {
  LayoutDashboard,
  Settings,
  Network,
  ScrollText,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Bot,
  Wrench,
  Users,
  Search,
  Menu,
  X,
  Sparkles,
  Bell,
  Brain,
  Waypoints,
} from 'lucide-react';
import { useUpdateStatus } from '../hooks/use-update-status';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { useHubStatus } from '../hooks/use-hub-status';
import { Button, buttonVariants } from '../components/ui/button';
import { GlobalSearch } from '../components/search/GlobalSearch';
import { NotificationBanner } from '../components/notifications/NotificationBanner';
import { NotificationPanel } from '../components/notifications/NotificationPanel';
import { SystemNotifications } from '../components/notifications/SystemNotifications';
import { useUnreadCount } from '../hooks/use-notifications';
import { cn } from '../lib/cn';
import { AppearanceSection } from './AppearanceSection';
import { DEFAULT_HUB_URL } from '@myco/constants/hub';

/* ---------- Constants ---------- */

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare },
  { to: '/cortex', label: 'Cortex', icon: Brain },
  { to: '/mycelium', label: 'Mycelium', icon: Network },
  { to: '/skills', label: 'Skills', icon: Sparkles },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/operations', label: 'Operations', icon: Wrench },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/logs', label: 'Logs', icon: ScrollText },
] as const;

const SIDEBAR_COLLAPSED_KEY = 'myco-ui-sidebar-collapsed';

/** Tailwind `md` breakpoint in pixels. Below this, the sidebar becomes a mobile drawer. */
const MOBILE_BREAKPOINT_PX = 768;
const CONFIG_FOCUS_SCROLL_DELAY_MS = 80;
const CONFIG_FOCUS_HIGHLIGHT_DURATION_MS = 2_000;
const CONFIG_FOCUS_HIGHLIGHT_CLASSES = [
  'ring-2',
  'ring-primary/40',
  'bg-primary/5',
];

/* ---------- Sidebar collapse hook ---------- */

function useSidebarCollapse() {
  const [collapsed, setCollapsedState] = useState(() => {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  });

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

/* ---------- Mobile drawer hook ---------- */

function useMobileDrawer() {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX,
  );

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const onChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) setOpen(false); // close drawer when switching to desktop
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Close drawer on route change
  const location = useLocation();
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [open]);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, isMobile, toggle, close };
}

/* ---------- Sub-components ---------- */

function RestartButton({ collapsed = false }: { collapsed?: boolean }) {
  const { restart, isRestarting } = useRestart();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => restart()}
      disabled={isRestarting}
      title={collapsed ? (isRestarting ? 'Restarting...' : 'Restart Daemon') : undefined}
      className={cn(
        'text-on-surface-variant hover:text-on-surface',
        collapsed ? 'w-8 p-0 justify-center' : 'w-full justify-start gap-2',
      )}
    >
      <RotateCcw className={cn('h-4 w-4', isRestarting && 'animate-spin')} />
      {!collapsed && <span>{isRestarting ? 'Restarting...' : 'Restart Daemon'}</span>}
    </Button>
  );
}

function HubLinkButton({ collapsed = false }: { collapsed?: boolean }) {
  const { data, isFetching, isError } = useHubStatus();
  const url = data?.url ?? DEFAULT_HUB_URL;
  const running = data?.running === true;
  const unavailableTitle = isFetching && !data
    ? `Checking Myco Hub at ${url}`
    : `Myco Hub is not connected at ${url}`;
  const title = running ? `Open Myco Hub at ${url}` : unavailableTitle;
  const iconClassName = cn('h-4 w-4 shrink-0', isFetching && !running && 'animate-pulse');
  const controlClassName = cn(
    'text-on-surface-variant hover:text-on-surface',
    collapsed ? 'w-8 p-0 justify-center' : 'w-full justify-start gap-2',
  );

  if (running) {
    return (
      <a
        href={url}
        target="_top"
        title={title}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          controlClassName,
        )}
      >
        <Waypoints className={iconClassName} />
        {!collapsed && <span>Open Hub</span>}
      </a>
    );
  }

  return (
    <span
      title={title}
      className={cn(collapsed ? 'inline-flex' : 'block w-full')}
    >
      <Button
        variant="ghost"
        size="sm"
        disabled
        aria-label={isError ? 'Myco Hub status unavailable' : 'Myco Hub offline'}
        className={controlClassName}
      >
        <Waypoints className={iconClassName} />
        {!collapsed && <span>{isFetching && !data ? 'Checking Hub' : 'Hub Offline'}</span>}
      </Button>
    </span>
  );
}

/* ---------- Sidebar content (shared between mobile and desktop) ---------- */

/** Self-contained Operations nav link — owns update polling, controls link target and badge. */
function OperationsNavLink({ collapsed }: { collapsed: boolean }) {
  const { data } = useUpdateStatus();
  const hasUpdate = !!(data && !data.exempt && data.update_available);
  const to = hasUpdate ? '/operations?tab=system' : '/operations';

  return (
    <NavLink
      to={to}
      title={collapsed ? 'Operations' : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center rounded-md text-sm font-medium transition-colors',
          collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
          isActive
            ? 'bg-primary/10 text-primary'
            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
        )
      }
    >
      <Wrench className="h-4 w-4 shrink-0" />
      {!collapsed && 'Operations'}
      {hasUpdate && (
        <span className="h-2 w-2 rounded-full bg-secondary shrink-0 ml-auto" />
      )}
    </NavLink>
  );
}

function SidebarContent({
  collapsed,
  vaultName,
  onSearchOpen,
  onNotificationsOpen,
  unreadCount,
  onCollapseToggle,
  showCollapseToggle,
}: {
  collapsed: boolean;
  vaultName: string | undefined;
  onSearchOpen: () => void;
  onNotificationsOpen: () => void;
  unreadCount: number;
  onCollapseToggle?: () => void;
  showCollapseToggle: boolean;
}) {
  return (
    <>
      {/* Brand + vault name */}
      <div className={cn('px-4 py-5', collapsed && 'px-2 py-4 flex justify-center')}>
        {collapsed ? (
          <div className="relative flex items-center">
            <span className="font-serif text-base text-primary">m</span>
            <span className="ml-1 h-2 w-2 rounded-full bg-on-surface-variant/40" />
          </div>
        ) : (
          <div>
            <div className="flex items-center">
              <span className="font-serif text-base text-primary tracking-wider">
                myco
              </span>
              <span className="ml-2 h-2 w-2 rounded-full bg-on-surface-variant/40" />
            </div>
            {vaultName && (
              <span className="font-mono text-xs text-outline uppercase tracking-widest mt-0.5">
                {vaultName}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Search + Notifications triggers */}
      <div className="px-2 pt-2 pb-1 space-y-0.5">
        <button
          type="button"
          onClick={onSearchOpen}
          title={collapsed ? 'Search (\u2318K)' : undefined}
          className={cn(
            'flex w-full items-center rounded-md text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface',
            collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
          )}
        >
          <Search className="h-4 w-4 shrink-0" />
          {!collapsed && (
            <span className="flex-1 text-left">Search</span>
          )}
          {!collapsed && (
            <kbd className="text-xs text-on-surface-variant/60 font-mono">{'\u2318'}K</kbd>
          )}
        </button>
        <button
          type="button"
          onClick={onNotificationsOpen}
          title={collapsed ? 'Notifications' : undefined}
          className={cn(
            'flex w-full items-center rounded-md text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface',
            collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
          )}
        >
          <Bell className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="flex-1 text-left">Notifications</span>}
          {unreadCount > 0 && (
            <span className={cn(
              'h-2 w-2 rounded-full bg-primary shrink-0',
              !collapsed && 'ml-auto',
            )} />
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2 py-2" aria-label="Main navigation">
        {NAV_ITEMS.map((item) =>
          item.to === '/operations' ? (
            <OperationsNavLink key={item.to} collapsed={collapsed} />
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  'flex items-center rounded-md text-sm font-medium transition-colors',
                  collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && item.label}
            </NavLink>
          ),
        )}
      </nav>

      {/* Footer */}
      <div className={cn('py-3 space-y-2 mt-auto', collapsed ? 'px-1 flex flex-col items-center' : 'px-2')}>
        {!collapsed && <AppearanceSection collapsed={collapsed} />}
        <HubLinkButton collapsed={collapsed} />
        <RestartButton collapsed={collapsed} />
      </div>

      {/* Collapse toggle — desktop only */}
      {showCollapseToggle && onCollapseToggle && (
        <div className={cn('px-2 py-2', collapsed && 'flex justify-center')}>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCollapseToggle}
            className={cn(
              'text-on-surface-variant hover:text-on-surface',
              collapsed ? 'w-8 p-0 justify-center' : 'w-full justify-start gap-2',
            )}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {!collapsed && <span>Collapse</span>}
          </Button>
        </div>
      )}
    </>
  );
}

/* ---------- Layout ---------- */

export default function Layout() {
  const { collapsed, toggle } = useSidebarCollapse();
  const { data: stats } = useDaemon();
  const vaultName = stats?.context.project.name ?? stats?.vault.name;
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifPanelOpen, setNotifPanelOpen] = useState(false);
  const { data: unreadData } = useUnreadCount();
  const unreadCount = unreadData?.count ?? 0;
  const drawer = useMobileDrawer();

  // Register Cmd+K / Ctrl+K global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close drawer when Escape is pressed
  useEffect(() => {
    if (!drawer.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        drawer.close();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [drawer.open, drawer.close]);

  const openSearch = useCallback(() => setSearchOpen(true), []);

  const openNotifPanel = useCallback(() => setNotifPanelOpen(true), []);
  const closeNotifPanel = useCallback(() => setNotifPanelOpen(false), []);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const field = params.get(CONFIG_FOCUS_FIELD_PARAM) ?? undefined;
    const section = params.get(CONFIG_FOCUS_SECTION_PARAM) ?? undefined;
    if (!field && !section) return;

    const timeoutId = window.setTimeout(() => {
      const target = findConfigFocusElement(field, section);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add(...CONFIG_FOCUS_HIGHLIGHT_CLASSES);
      window.setTimeout(() => {
        target.classList.remove(...CONFIG_FOCUS_HIGHLIGHT_CLASSES);
      }, CONFIG_FOCUS_HIGHLIGHT_DURATION_MS);
    }, CONFIG_FOCUS_SCROLL_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [location.key, location.search]);

  return (
    <div className="flex h-screen bg-background">
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      <NotificationBanner panelOpen={notifPanelOpen} />
      <NotificationPanel open={notifPanelOpen} onClose={closeNotifPanel} />
      <SystemNotifications />

      {/* Mobile top bar — visible below md breakpoint */}
      {drawer.isMobile && (
        <div className="fixed top-0 left-0 right-0 z-40 flex h-12 items-center gap-3 border-b border-outline-variant/20 bg-surface-container px-3">
          <button
            type="button"
            onClick={drawer.toggle}
            className="rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            aria-label={drawer.open ? 'Close navigation' : 'Open navigation'}
          >
            {drawer.open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="font-serif text-base text-primary tracking-wider">myco</span>
          {vaultName && (
            <span className="font-mono text-[10px] text-outline uppercase tracking-widest">
              {vaultName}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={openNotifPanel}
              className="relative rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
              {unreadCount > 0 && (
                <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-primary" />
              )}
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
              aria-label="Search"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Mobile drawer overlay */}
      {drawer.isMobile && drawer.open && (
        <div
          className="fixed inset-0 z-40 bg-surface-dim/60 backdrop-blur-xs transition-opacity"
          onClick={drawer.close}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer sidebar */}
      {drawer.isMobile && (
        <aside
          className={cn(
            'fixed top-12 left-0 bottom-0 z-50 w-64 flex flex-col bg-surface-container transition-transform duration-200 ease-out',
            drawer.open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <SidebarContent
            collapsed={false}
            vaultName={vaultName}
            onSearchOpen={openSearch}
            onNotificationsOpen={openNotifPanel}
            unreadCount={unreadCount}
            showCollapseToggle={false}
          />
        </aside>
      )}

      {/* Desktop sidebar — hidden below md breakpoint */}
      {!drawer.isMobile && (
        <aside
          className={cn(
            'flex flex-col bg-surface-container transition-[width] duration-200',
            collapsed ? 'w-14' : 'w-56',
          )}
        >
          <SidebarContent
            collapsed={collapsed}
            vaultName={vaultName}
            onSearchOpen={openSearch}
            onNotificationsOpen={openNotifPanel}
            unreadCount={unreadCount}
            onCollapseToggle={toggle}
            showCollapseToggle={true}
          />
        </aside>
      )}

      {/* Main content */}
      <main
        className={cn(
          'flex-1 overflow-auto bg-surface',
          drawer.isMobile && 'pt-12', // offset for fixed mobile top bar
        )}
        aria-label="Page content"
      >
        <Outlet />
      </main>
    </div>
  );
}

function findConfigFocusElement(field?: string, section?: string): HTMLElement | null {
  if (field) {
    let current = field;
    while (current.length > 0) {
      const element = document.getElementById(configFieldId(current));
      if (element instanceof HTMLElement) return element;
      const lastDot = current.lastIndexOf('.');
      if (lastDot === -1) break;
      current = current.slice(0, lastDot);
    }
  }

  if (section) {
    const sectionElement = document.getElementById(section);
    if (sectionElement instanceof HTMLElement) return sectionElement;
  }

  return null;
}
