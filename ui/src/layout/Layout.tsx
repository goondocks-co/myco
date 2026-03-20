import { NavLink, Outlet } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Wrench,
  ScrollText,
  Sun,
  Moon,
  FolderOpen,
  ExternalLink,
} from 'lucide-react';
import { useTheme } from '../providers/theme';
import { useDaemon } from '../hooks/use-daemon';
import { Button } from '../components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { cn } from '../lib/cn';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/configuration', label: 'Configuration', icon: Settings },
  { to: '/operations', label: 'Operations', icon: Wrench },
  { to: '/logs', label: 'Logs', icon: ScrollText },
] as const;

const VAULT_OPEN_OPTIONS = [
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'finder', label: 'Finder' },
] as const;

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
    <Select onValueChange={handleOpenVault} disabled={!stats}>
      <SelectTrigger className="w-full border-none bg-transparent text-muted-foreground shadow-none hover:text-foreground text-sm h-8">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4" />
          <SelectValue placeholder="Open Vault" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {VAULT_OPEN_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            <span className="flex items-center gap-2">
              {opt.label}
              <ExternalLink className="h-3 w-3 opacity-50" />
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Layout() {
  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar */}
      <aside className="flex w-56 flex-col border-r border-border bg-card">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-5">
          <div className="relative flex items-center">
            <span className="text-xl font-bold tracking-tight text-primary">
              myco
            </span>
            {/* Health indicator — wired in Task 10 */}
            <span className="ml-2 h-2 w-2 rounded-full bg-muted-foreground/40" />
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-1 px-2 py-2">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-border px-2 py-3 space-y-1">
          <ThemeToggle />
          <OpenVaultSelect />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
