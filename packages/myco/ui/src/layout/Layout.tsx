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
  Users,
  Search,
  Menu,
  X,
  Sparkles,
  Bell,
  Brain,
  Trees,
  FolderTree,
  Activity,
  Plug,
} from 'lucide-react';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { useProjectPath, useProjectSelection } from '../hooks/use-project-selection';
import { useGroves } from '../hooks/use-groves';
import { selectionFromLast, defaultSelection, type ProjectSelection, type GroveSummary } from '../lib/selection';
import { Button } from '../components/ui/button';
import { GlobalSearch } from '../components/search/GlobalSearch';
import { ProjectSwitcher } from '../components/ProjectSwitcher';
import { NotificationBanner } from '../components/notifications/NotificationBanner';
import { NotificationPanel } from '../components/notifications/NotificationPanel';
import { SystemNotifications } from '../components/notifications/SystemNotifications';
import { useUnreadCount } from '../hooks/use-notifications';
import { cn } from '../lib/cn';
import { monogramFor } from '../lib/selection';
import { AppearanceSection } from './AppearanceSection';
import { Topbar } from './Topbar';

/* ---------- Constants ---------- */

type NavScope = 'project' | 'grove' | 'machine';
type NavCategory = 'Project' | 'Observability' | 'Grove management' | 'Settings';

export interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  scope: NavScope;
  category: NavCategory;
}

const NAV_ORDER: readonly NavCategory[] = ['Project', 'Observability', 'Grove management', 'Settings'];

const navItems: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, scope: 'project', category: 'Project' },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare, scope: 'project', category: 'Project' },
  { to: '/agent', label: 'Agent', icon: Bot, scope: 'project', category: 'Project' },
  { to: '/cortex', label: 'Cortex', icon: Brain, scope: 'project', category: 'Project' },
  { to: '/mycelium', label: 'Mycelium', icon: Network, scope: 'project', category: 'Project' },
  { to: '/skills', label: 'Skills', icon: Sparkles, scope: 'project', category: 'Project' },
  { to: '/g/:groveSlug/operations', label: 'Operations', icon: Activity, scope: 'grove', category: 'Observability' },
  { to: '/logs', label: 'Logs', icon: ScrollText, scope: 'machine', category: 'Observability' },
  { to: '/g/:groveSlug/dashboard', label: 'Grove', icon: Trees, scope: 'grove', category: 'Grove management' },
  { to: '/groves', label: 'Groves', icon: FolderTree, scope: 'machine', category: 'Grove management' },
  { to: '/symbionts', label: 'Symbionts', icon: Plug, scope: 'machine', category: 'Grove management' },
  { to: '/g/:groveSlug/team', label: 'Team', icon: Users, scope: 'grove', category: 'Grove management' },
  { to: '/settings', label: 'Settings', icon: Settings, scope: 'machine', category: 'Settings' },
];

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

/* ---------- Sidebar content (shared between mobile and desktop) ---------- */

/**
 * Visual indicator that the daemon is running off a non-stable runtime
 * — a dev binary (`make dev-link`, `npm link`, etc.) or the managed
 * beta runtime under `~/.myco/runtime/`. Always visible while non-
 * stable; nothing rendered for stable installs.
 *
 * Lives in the sidebar so it's persistent across pages — there's no
 * good reason to hunt for it on a settings tab when the question is
 * "am I on the dogfood daemon right now?"
 */
function RuntimeBadge({ collapsed }: { collapsed: boolean }) {
  const { data } = useDaemon();
  const runtime = data?.daemon.runtime;
  if (!runtime || runtime.source === 'stable') return null;

  const isDev = runtime.source === 'dev';
  const label = isDev ? 'DEV' : 'BETA';
  const tooltip = isDev
    ? 'Daemon is running from a dev binary (make dev-link / npm link).'
    : 'Daemon is running from the managed beta runtime under ~/.myco/runtime/.';
  const colorClasses = isDev
    ? 'bg-tertiary/20 text-tertiary border-tertiary/40'
    : 'bg-secondary/20 text-secondary border-secondary/40';

  if (collapsed) {
    return (
      <div
        className={cn(
          'mx-auto flex h-5 w-8 items-center justify-center rounded border text-[10px] font-bold tracking-wider',
          colorClasses,
        )}
        title={tooltip}
      >
        {label}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mx-2 flex items-center justify-center rounded border px-2 py-1 text-[11px] font-semibold tracking-wider',
        colorClasses,
      )}
      title={tooltip}
    >
      {label} runtime
    </div>
  );
}

function SidebarContent({
  collapsed,
  onSearchOpen,
  onNotificationsOpen,
  unreadCount,
  onCollapseToggle,
  showCollapseToggle,
}: {
  collapsed: boolean;
  onSearchOpen: () => void;
  onNotificationsOpen: () => void;
  unreadCount: number;
  onCollapseToggle?: () => void;
  showCollapseToggle: boolean;
}) {
  return (
    <>
      <ProjectSwitcher collapsed={collapsed} />

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
        {NAV_ORDER.map((category) => {
          const items = navItems.filter((i) => i.category === category);
          if (items.length === 0) return null;
          return (
            <NavGroup key={category} label={category} collapsed={collapsed}>
              {items.map((item) => (
                <SidebarNavLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </NavGroup>
          );
        })}
      </nav>

      {/* Footer */}
      <div className={cn('py-3 space-y-2 mt-auto', collapsed ? 'px-1 flex flex-col items-center' : 'px-2')}>
        <RuntimeBadge collapsed={collapsed} />
        {!collapsed && <AppearanceSection collapsed={collapsed} />}
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

function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  // Collapsed sidebar: emit a divider above each group to preserve grouping.
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'space-y-0.5',
        collapsed && 'border-t border-[var(--ghost-border)] pt-3 mt-3 first:border-t-0 first:pt-0 first:mt-0',
      )}
    >
      {!collapsed && (
        <div className="px-3 pt-4 pb-1 text-[10px] uppercase tracking-wider text-on-surface-variant">
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Resolve the URL a sidebar nav item should point to, given the current
 * project selection and the loaded grove list.
 *
 * Machine-wide pages (/groves, /logs, /settings) render under
 * GlobalSelectionBoundary — useProjectSelection() returns null there.
 * For grove-scoped nav items (Operations, Grove, Team), we still need a
 * grove slug to build a valid URL. We resolve a fallback the same way
 * LegacyGroveRedirect does, so the sidebar never silently rewrites
 * grove-scoped links to '/'.
 *
 * Exported for unit testing.
 */
export function resolveNavLinkTo(
  item: NavItem,
  selection: ProjectSelection | null,
  projectScopedTo: string,
  groveList: readonly GroveSummary[],
): string {
  if (item.scope === 'project') return projectScopedTo;
  if (item.scope === 'machine') return item.to;
  // grove-scoped:
  if (!item.to.includes(':groveSlug')) return projectScopedTo;
  const grove =
    selection?.grove
    ?? selectionFromLast(groveList as GroveSummary[])?.grove
    ?? defaultSelection(groveList as GroveSummary[])?.grove
    ?? groveList[0];
  return grove ? item.to.replace(':groveSlug', grove.slug) : '/';
}

function SidebarNavLink({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  const selection = useProjectSelection();
  const projectScopedTo = useProjectPath(item.to);
  const grovesQuery = useGroves();
  const to = resolveNavLinkTo(
    item,
    selection,
    projectScopedTo,
    grovesQuery.data?.groves ?? [],
  );
  return (
    <NavLink
      to={to}
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
  );
}

function useDocumentIdentity(vaultName: string | undefined) {
  const selection = useProjectSelection();
  useEffect(() => {
    const projectName = selection?.project.name ?? vaultName ?? null;
    document.title = projectName
      ? `${selection ? `${monogramFor(selection.project.name)} ` : ''}${projectName} - Myco`
      : 'Myco';
    // Favicon stays as the static /favicon-<theme>.svg owned by
    // appearance-apply.ts. The previous per-project monogram canvas
    // favicon stomped on the theme favicon and bled the project
    // switcher's branding into the OS tab UI; both are fine inside the
    // app chrome (sidebar) but the favicon is global and should stay
    // stable.
  }, [selection, vaultName]);
}

/* ---------- Layout ---------- */

export default function Layout() {
  const { collapsed, toggle } = useSidebarCollapse();
  const { data: stats } = useDaemon();
  const selection = useProjectSelection();
  const vaultName = selection?.project.name ?? stats?.context.project.name ?? stats?.vault.name;
  useDocumentIdentity(vaultName);
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
        {!drawer.isMobile && (
          <Topbar
            onOpenSearch={openSearch}
            onOpenNotifications={openNotifPanel}
            unreadCount={unreadCount}
          />
        )}
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
