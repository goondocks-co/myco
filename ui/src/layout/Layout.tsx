import { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Network,
  ScrollText,
  Sun,
  Moon,
  FolderOpen,
  RotateCcw,
  Type,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Bot,
  Wrench,
  Search,
} from 'lucide-react';
import { useTheme } from '../providers/theme';
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
  { to: '/logs', label: 'Logs', icon: ScrollText },
] as const;

const VAULT_OPEN_OPTIONS = [
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'finder', label: 'Finder' },
] as const;

const FONT_OPTIONS: { value: FontOption; label: string }[] = [
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

/* ---------- Sub-components ---------- */

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const toggleTheme = () => {
    if (theme === 'dark') {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  const isDark =
    theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleTheme}
      className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span>{isDark ? 'Light mode' : 'Dark mode'}</span>
    </Button>
  );
}

function RestartButton() {
  const { restart, isRestarting } = useRestart();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => restart()}
      disabled={isRestarting}
      className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
    >
      <RotateCcw className={cn('h-4 w-4', isRestarting && 'animate-spin')} />
      <span>{isRestarting ? 'Restarting...' : 'Restart Daemon'}</span>
    </Button>
  );
}

function OpenVaultSelect() {
  const { data: stats } = useDaemon();

  const handleOpenVault = (value: string) => {
    if (!stats) return;
    let uri: string;
    if (value === 'obsidian') {
      uri = `obsidian://open?vault=${encodeURIComponent(stats.vault.name)}`;
    } else if (value === 'vscode') {
      uri = `vscode://file${stats.vault.path}`;
    } else {
      uri = `file://${stats.vault.path}`;
    }
    window.location.href = uri;
  };

  return (
    <label className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer">
      <FolderOpen className="h-4 w-4 shrink-0" />
      <select
        value=""
        onChange={(e) => { if (e.target.value) handleOpenVault(e.target.value); e.target.value = ''; }}
        disabled={!stats}
        className="w-full bg-transparent border-none outline-none cursor-pointer text-sm appearance-none disabled:opacity-50"
      >
        <option value="" disabled>Open Vault</option>
        {VAULT_OPEN_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </label>
  );
}

function FontSelector() {
  const { font, setFont } = useFont();

  return (
    <label className="flex items-center gap-2 px-2 py-1 text-sm text-muted-foreground hover:text-foreground cursor-pointer">
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

function DensityControl() {
  const { density, setDensity } = useDensity();
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
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        aria-label="Decrease density"
      >
        <Minus className="h-3 w-3" />
      </button>
      <div className="flex flex-1 justify-center">
        <span className="text-xs text-muted-foreground select-none">
          {DENSITY_LABELS[density]}
        </span>
      </div>
      <button
        onClick={increase}
        disabled={currentIndex === DENSITY_ORDER.length - 1}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        aria-label="Increase density"
      >
        <Plus className="h-3 w-3" />
      </button>
    </div>
  );
}

/* ---------- Layout ---------- */

export default function Layout() {
  const { collapsed, toggle } = useSidebarCollapse();
  const { data: stats } = useDaemon();
  const vaultName = stats?.vault.name;
  const [searchOpen, setSearchOpen] = useState(false);

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

  return (
    <div className="flex h-screen bg-background">
      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-card transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-56',
        )}
      >
        {/* Brand + vault name */}
        <div className={cn('px-4 py-5', collapsed && 'px-2 py-4 flex justify-center')}>
          {collapsed ? (
            <div className="relative flex items-center">
              <span className="text-base font-bold tracking-tight text-primary">m</span>
              <span className="ml-1 h-2 w-2 rounded-full bg-muted-foreground/40" />
            </div>
          ) : (
            <div>
              <div className="flex items-center">
                <span className="text-sm font-medium tracking-tight text-muted-foreground">
                  myco
                </span>
                <span className="ml-2 h-2 w-2 rounded-full bg-muted-foreground/40" />
              </div>
              {vaultName && (
                <span className="text-lg font-bold tracking-tight text-primary">
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
            onClick={() => setSearchOpen(true)}
            title={collapsed ? 'Search (⌘K)' : undefined}
            className={cn(
              'flex w-full items-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
            )}
          >
            <Search className="h-4 w-4 shrink-0" />
            {!collapsed && (
              <span className="flex-1 text-left">Search</span>
            )}
            {!collapsed && (
              <kbd className="text-xs text-muted-foreground/60 font-mono">⌘K</kbd>
            )}
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-2 py-2">
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
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="border-t border-border px-2 py-3 space-y-1">
            <RestartButton />
            <OpenVaultSelect />
            <FontSelector />
            <DensityControl />
            <ThemeToggle />
          </div>
        )}

        {/* Collapse toggle */}
        <div className={cn('border-t border-border px-2 py-2', collapsed && 'flex justify-center')}>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            className={cn(
              'text-muted-foreground hover:text-foreground',
              collapsed ? 'w-8 p-0 justify-center' : 'w-full justify-start gap-2',
            )}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            {!collapsed && <span>Collapse</span>}
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
