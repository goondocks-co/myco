import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Network,
  ScrollText,
  Sun,
  Moon,
  Monitor,
  RotateCcw,
  Type,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Bot,
  Wrench,
  Users,
  Search,
  Menu,
  X,
} from 'lucide-react';
import { useTheme } from '../providers/theme';
import { useUpdateStatus } from '../hooks/use-update-status';
import { useFont, type FontOption } from '../providers/font';
import { useDaemon } from '../hooks/use-daemon';
import { useRestart } from '../hooks/use-restart';
import { Button } from '../components/ui/button';
import { GlobalSearch } from '../components/search/GlobalSearch';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/sessions', label: 'Sessions', icon: MessageSquare },
  { to: '/mycelium', label: 'Mycelium', icon: Network },
  { to: '/agent', label: 'Agent', icon: Bot },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/operations', label: 'Operations', icon: Wrench },
  { to: '/team', label: 'Team', icon: Users },
  { to: '/logs', label: 'Logs', icon: ScrollText },
] as const;

const FONT_OPTIONS: { value: FontOption; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'geist-mono', label: 'Geist Mono' },
  { value: 'system', label: 'System' },
  { value: 'sf-mono', label: 'SF Mono' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'jetbrains-mono', label: 'JetBrains' },
];

type Density = 'compact' | 'normal' | 'comfy';

const DENSITY_VALUES: Record<Density, number> = {
  compact: 0.85,
  normal: 1,
  comfy: 1.15,
};

const DENSITY_LABELS: Record<Density, string> = {
  compact: 'Compact',
  normal: 'Normal',
  comfy: 'Comfy',
};

const DENSITY_ORDER: Density[] = ['compact', 'normal', 'comfy'];

const SIDEBAR_COLLAPSED_KEY = 'myco-ui-sidebar-collapsed';

/** Tailwind `md` breakpoint in pixels. Below this, the sidebar becomes a mobile drawer. */
const MOBILE_BREAKPOINT_PX = 768;

const DENSITY_STORAGE_KEY = 'myco-ui-density';
const DENSITY_CSS_VAR = '--density';
const DEFAULT_DENSITY: Density = 'normal';

/* ---------- Density hook ---------- */

function getStoredDensity(): Density {
  const stored = localStorage.getItem(DENSITY_STORAGE_KEY);
  if (stored && stored in DENSITY_VALUES) {
    return stored as Density;
  }
  return DEFAULT_DENSITY;
}

function applyDensity(density: Density): void {
  const value = DENSITY_VALUES[density];
  document.documentElement.style.setProperty(DENSITY_CSS_VAR, String(value));
  document.documentElement.style.fontSize = `calc(14px * ${value})`;
}

function useDensity() {
  const [density, setDensityState] = useState<Density>(getStoredDensity);

  const setDensity = useCallback((next: Density) => {
    localStorage.setItem(DENSITY_STORAGE_KEY, next);
    setDensityState(next);
  }, []);

  useEffect(() => {
    applyDensity(density);
  }, [density]);

  return { density, setDensity };
}

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

/** Theme cycle order: light → dark → system → light. */
const THEME_CYCLE = ['light', 'dark', 'system'] as const;

const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' } as const;

function ThemeToggle({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, setTheme } = useTheme();

  const cycleTheme = () => {
    const idx = THEME_CYCLE.indexOf(theme as typeof THEME_CYCLE[number]);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length]!;
    setTheme(next);
  };

  const Icon = THEME_ICONS[theme as keyof typeof THEME_ICONS] ?? Monitor;
  const label = THEME_LABELS[theme as keyof typeof THEME_LABELS] ?? 'System';

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={cycleTheme}
      title={collapsed ? `${label} mode` : undefined}
      className={cn(
        'text-on-surface-variant hover:text-on-surface',
        collapsed ? 'w-8 p-0 justify-center' : 'w-full justify-start gap-2',
      )}
    >
      <Icon className="h-4 w-4" />
      {!collapsed && <span>{label}</span>}
    </Button>
  );
}

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

function FontSelector() {
  const { font, setFont } = useFont();

  return (
    <label className="flex items-center gap-2 px-2 py-1 text-sm text-on-surface-variant hover:text-on-surface cursor-pointer">
      <Type className="h-4 w-4 shrink-0" />
      <select
        value={font}
        onChange={(e) => setFont(e.target.value as FontOption)}
        className="w-full bg-transparent border-none outline-none cursor-pointer text-sm appearance-none"
      >
        {FONT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function DensityControl({ density, setDensity }: { density: Density; setDensity: (d: Density) => void }) {
  const currentIndex = DENSITY_ORDER.indexOf(density);

  const decrease = () => {
    const prev = DENSITY_ORDER[currentIndex - 1];
    if (currentIndex > 0 && prev !== undefined) {
      setDensity(prev);
    }
  };

  const increase = () => {
    const next = DENSITY_ORDER[currentIndex + 1];
    if (currentIndex < DENSITY_ORDER.length - 1 && next !== undefined) {
      setDensity(next);
    }
  };

  return (
    <div className="flex items-center gap-1 px-3 py-1">
      <button
        onClick={decrease}
        disabled={currentIndex === 0}
        className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
        aria-label="Decrease density"
      >
        <Minus className="h-3 w-3" />
      </button>
      <div className="flex flex-1 justify-center">
        <span className="text-xs text-on-surface-variant select-none">
          {DENSITY_LABELS[density]}
        </span>
      </div>
      <button
        onClick={increase}
        disabled={currentIndex === DENSITY_ORDER.length - 1}
        className="rounded p-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-30"
        aria-label="Increase density"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

/* ---------- Sidebar content (shared between mobile and desktop) ---------- */

function SidebarContent({
  collapsed,
  vaultName,
  density,
  setDensity,
  onSearchOpen,
  onCollapseToggle,
  showCollapseToggle,
  updateAvailable,
}: {
  collapsed: boolean;
  vaultName: string | undefined;
  density: Density;
  setDensity: (d: Density) => void;
  onSearchOpen: () => void;
  onCollapseToggle?: () => void;
  showCollapseToggle: boolean;
  updateAvailable: boolean;
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

      {/* Search trigger */}
      <div className="px-2 pt-2 pb-1">
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
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-2 py-2" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
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
            {item.to === '/operations' && updateAvailable && (
              <span className="h-2 w-2 rounded-full bg-secondary shrink-0 ml-auto" />
            )}
          </NavLink>
        ))}
      </nav>

      {/* Footer */}
      <div className={cn('py-3 space-y-1 mt-auto', collapsed ? 'px-1 flex flex-col items-center' : 'px-2')}>
        <RestartButton collapsed={collapsed} />
        {!collapsed && <FontSelector />}
        {!collapsed && <DensityControl density={density} setDensity={setDensity} />}
        <ThemeToggle collapsed={collapsed} />
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
  const { density, setDensity } = useDensity();
  const { data: stats } = useDaemon();
  const vaultName = stats?.vault.name;
  const [searchOpen, setSearchOpen] = useState(false);
  const drawer = useMobileDrawer();
  const { data: updateData } = useUpdateStatus();
  const updateAvailable = !!(updateData && !updateData.exempt && updateData.update_available);

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

  return (
    <div className="flex h-screen bg-background">
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />

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
          <button
            type="button"
            onClick={openSearch}
            className="ml-auto rounded-md p-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
            aria-label="Search"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Mobile drawer overlay */}
      {drawer.isMobile && drawer.open && (
        <div
          className="fixed inset-0 z-40 bg-surface-dim/60 backdrop-blur-sm transition-opacity"
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
            density={density}
            setDensity={setDensity}
            onSearchOpen={openSearch}
            showCollapseToggle={false}
            updateAvailable={updateAvailable}
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
            density={density}
            setDensity={setDensity}
            onSearchOpen={openSearch}
            onCollapseToggle={toggle}
            showCollapseToggle={true}
            updateAvailable={updateAvailable}
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
