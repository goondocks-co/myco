import { DatabaseZap, Layers3, LogOut, Radar, Search, Settings2 } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { cn } from '../lib/cn';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', icon: Radar },
  { to: '/projects', label: 'Projects', icon: Layers3 },
  { to: '/settings', label: 'Settings', icon: Settings2 },
  { to: '/search', label: 'Search', icon: Search },
] as const;

export interface LayoutProps {
  collectiveName: string;
  onLogout: () => void;
}

export default function Layout({ collectiveName, onLogout }: LayoutProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1540px] flex-col gap-6 px-4 py-4 md:px-6 lg:flex-row lg:px-8 lg:py-8">
      <aside className="w-full rounded-[32px] border border-[rgba(255,231,208,0.11)] bg-[linear-gradient(180deg,rgba(21,13,10,0.98),rgba(10,7,6,0.98))] p-5 shadow-[0_22px_70px_rgba(0,0,0,0.32)] lg:sticky lg:top-8 lg:h-[calc(100vh-4rem)] lg:w-[320px]">
        <div className="mb-8 space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,231,208,0.12)] bg-[rgba(255,244,230,0.05)] px-3 py-1 text-[11px] uppercase tracking-[0.34em] text-[#cfae95]">
            <DatabaseZap className="h-3.5 w-3.5" />
            Collective Control Plane
          </div>
          <div>
            <h1 className="font-display text-4xl leading-none text-[#fff4e8] md:text-[3.35rem]">{collectiveName}</h1>
            <p className="mt-3 max-w-[22rem] text-sm leading-6 text-[#b9a291]">
              One operator surface for project registration, override transport, and cross-project memory search.
            </p>
          </div>
        </div>

        <nav className="space-y-2">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => cn(
                'flex items-center justify-between rounded-2xl px-4 py-3 text-sm transition-colors',
                isActive
                  ? 'bg-[linear-gradient(135deg,rgba(247,179,106,0.20),rgba(241,139,83,0.16))] text-[#fff3e5]'
                  : 'text-[#c7b0a0] hover:bg-[rgba(255,244,230,0.05)] hover:text-[#fff3e5]',
              )}
            >
              <span className="flex items-center gap-3">
                <Icon className="h-4 w-4" />
                {label}
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="mt-8 rounded-[26px] border border-[rgba(255,231,208,0.11)] bg-[rgba(255,248,240,0.04)] p-4">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#a68d7a]">Release Discipline</p>
          <p className="mt-3 text-sm leading-6 text-[#cfbbab]">
            Package releases are isolated by tag prefix, so Collective changes stay decoupled from local Myco and team-worker publishes.
          </p>
        </div>

        <Button variant="ghost" className="mt-6 w-full justify-between" onClick={onLogout}>
          Clear Admin Token
          <LogOut className="h-4 w-4" />
        </Button>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
