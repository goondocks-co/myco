import { useCallback, useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Layers3,
  LogOut,
  Menu,
  Moon,
  Orbit,
  Radar,
  Search,
  Settings2,
  Sun,
  X,
} from 'lucide-react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { useTheme } from '../providers/theme';
import { cn } from '../lib/cn';
import { formatCollectiveName } from '../lib/format';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: Radar },
  { to: '/mcp-settings', label: 'MCP', icon: Orbit },
  { to: '/projects', label: 'Projects', icon: Layers3 },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/search', label: 'Search', icon: Search },
] as const;

const SIDEBAR_COLLAPSED_KEY = 'myco-collective-sidebar-collapsed';
const MOBILE_BREAKPOINT_PX = 1024;

export interface LayoutProps {
  collectiveName: string;
  onLogout: () => void;
}

function useSidebarCollapse() {
  const [collapsed, setCollapsedState] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true');

  const toggle = useCallback(() => {
    setCollapsedState((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}

function useMobileDrawer() {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < MOBILE_BREAKPOINT_PX,
  );
  const location = useLocation();

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const onChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
      if (!event.matches) setOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;

    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  return {
    isMobile,
    open,
    toggle: () => setOpen((prev) => !prev),
    close: () => setOpen(false),
  };
}

function ThemeToggle({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const Icon = theme === 'dark' ? Sun : Moon;
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setTheme(nextTheme)}
      title={collapsed ? label : undefined}
      className={cn(collapsed ? 'h-8 w-8 p-0' : 'w-full justify-start gap-2 px-2')}
    >
      <Icon className="h-4 w-4" />
      {!collapsed && <span>{label}</span>}
    </Button>
  );
}

function SidebarContent({
  collectiveName,
  collapsed,
  onLogout,
  onCollapseToggle,
  showCollapseToggle,
}: {
  collectiveName: string;
  collapsed: boolean;
  onLogout: () => void;
  onCollapseToggle?: () => void;
  showCollapseToggle: boolean;
}) {
  const displayName = formatCollectiveName(collectiveName);
  const compactLabel = displayName.replace(/\s+Collective$/i, '');

  return (
    <div className="flex h-full flex-col gap-5">
      <div className="min-w-0">
        <div className={cn('font-serif leading-none text-on-surface', collapsed ? 'text-2xl' : 'text-[1.55rem]')}>
          myco
        </div>
        <div className={cn('mt-2 font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant', collapsed && 'text-center')}>
          {collapsed ? compactLabel.slice(0, 3) : displayName}
        </div>
      </div>

      <nav className="space-y-1" aria-label="Collective navigation">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center rounded-md text-sm font-medium transition-colors',
                collapsed ? 'justify-center px-3 py-2.5' : 'gap-3 px-3 py-2.5',
                isActive
                  ? 'bg-surface-container-high text-on-surface shadow-[inset_2px_0_0_var(--primary)]'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-2">
        <ThemeToggle collapsed={collapsed} />
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          title={collapsed ? 'Clear Admin Token' : undefined}
          className={cn(collapsed ? 'h-8 w-8 p-0' : 'w-full justify-between px-2')}
        >
          {!collapsed && <span>Clear Admin Token</span>}
          <LogOut className="h-4 w-4" />
        </Button>
        {showCollapseToggle && onCollapseToggle && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCollapseToggle}
            title={collapsed ? 'Expand sidebar' : undefined}
            className={cn(collapsed ? 'h-8 w-8 p-0' : 'w-full justify-between px-2')}
          >
            {!collapsed && <span>Collapse</span>}
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function Layout({ collectiveName, onLogout }: LayoutProps) {
  const { collapsed, toggle } = useSidebarCollapse();
  const mobile = useMobileDrawer();
  const displayName = formatCollectiveName(collectiveName);

  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-30 border-b border-[var(--ghost-border)] bg-surface/90 backdrop-blur lg:hidden">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-on-surface-variant">myco</p>
            <div className="truncate font-serif text-xl text-on-surface">{displayName}</div>
          </div>
          <Button variant="ghost" size="icon" onClick={mobile.toggle} aria-label="Toggle navigation">
            {mobile.open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </header>

      {mobile.isMobile && mobile.open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm" onClick={mobile.close} />
          <aside className="fixed inset-y-0 left-0 z-50 w-[88vw] max-w-sm border-r border-[var(--ghost-border)] bg-surface-container-low px-4 py-5">
            <SidebarContent
              collectiveName={displayName}
              collapsed={false}
              onLogout={onLogout}
              showCollapseToggle={false}
            />
          </aside>
        </>
      )}

      <div className="mx-auto flex max-w-[1600px] gap-0 lg:min-h-screen">
        <aside
          className={cn(
            'hidden shrink-0 border-r border-[var(--ghost-border)] bg-surface-container-low lg:block',
            collapsed ? 'w-[82px]' : 'w-[248px]',
          )}
        >
          <div className={cn('sticky top-0 min-h-screen', collapsed ? 'px-2 py-4' : 'px-4 py-5')}>
            <SidebarContent
              collectiveName={displayName}
              collapsed={collapsed}
              onLogout={onLogout}
              onCollapseToggle={toggle}
              showCollapseToggle
            />
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8 lg:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
