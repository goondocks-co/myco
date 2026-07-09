import { useLocation } from 'react-router-dom';
import { Bell, Command, Search } from 'lucide-react';
import { cn } from '../lib/cn';
import { GitIdentityPill } from '../components/ui/git-identity-pill';
import { DaemonStatusPill } from '../components/ui/daemon-status-pill';
import { CortexStatusPill } from '../components/ui/cortex-status-pill';
import { useGitIdentity } from '../hooks/use-git-identity';
import { useProjectPath } from '../hooks/use-project-selection';
import { PageScopeBadge } from './PageScopeBadge';

const ROUTE_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/sessions': 'Sessions',
  '/cortex': 'Cortex',
  '/mycelium': 'Mycelium',
  '/skills': 'Skills',
  '/agent': 'Agent',
  '/settings': 'Settings',
  '/logs': 'Logs',
  '/machine': 'Machine',
  '/groves': 'Groves',
};

function breadcrumbFor(pathname: string): string[] {
  // Strip grove/project scope prefix so the breadcrumb shows the page,
  // not "g". Layout wraps project-scoped routes as /g/<grove>/p/<project>/<page>
  // and grove-scoped routes as /g/<grove>/<page>.
  let effective = pathname;
  const projectScoped = pathname.match(/^\/g\/[^/]+\/p\/[^/]+(\/.*)?$/);
  if (projectScoped) {
    effective = projectScoped[1] || '/';
  } else {
    const groveScoped = pathname.match(/^\/g\/[^/]+(\/.*)?$/);
    if (groveScoped) {
      effective = groveScoped[1] || '/';
    }
  }
  if (effective === '/') return ['Dashboard'];
  const segments = effective.split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';
  const top = `/${firstSegment}`;
  const topLabel = ROUTE_LABELS[top] ?? firstSegment;
  return [topLabel];
}

export interface TopbarProps {
  onOpenSearch: () => void;
  onOpenNotifications: () => void;
  unreadCount: number;
  className?: string;
}

export function Topbar({
  onOpenSearch,
  onOpenNotifications,
  unreadCount,
  className,
}: TopbarProps) {
  const location = useLocation();
  const trail = breadcrumbFor(location.pathname);
  const gitIdentity = useGitIdentity();
  const cortexPath = useProjectPath('/cortex');

  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-outline-variant/20 bg-surface-container/90 backdrop-blur px-4',
        className,
      )}
    >
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 font-sans text-xs text-on-surface-variant">
        {trail.map((label, i) => (
          <span key={i} className={cn(i === trail.length - 1 && 'text-on-surface')}>
            {i > 0 && <span className="mx-1">/</span>}
            {label}
          </span>
        ))}
      </nav>
      <PageScopeBadge />

      <button
        type="button"
        onClick={onOpenSearch}
        aria-label="Search"
        className="ml-auto inline-flex h-7 items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 text-on-surface-variant hover:bg-surface-container-high transition-colors"
      >
        <Search className="h-3 w-3" />
        <span className="font-sans text-xs">Search</span>
        <kbd className="inline-flex items-center gap-0.5 font-mono text-[10px] text-on-surface-variant/70">
          <Command className="h-2.5 w-2.5" />K
        </kbd>
      </button>

      <DaemonStatusPill to="/settings?configSection=upgrade#upgrade" />
      <CortexStatusPill to={cortexPath} />
      <GitIdentityPill
        data={gitIdentity.data}
        isPending={gitIdentity.isPending}
        isError={gitIdentity.isError}
        to="/settings?configSection=release-provenance#release-provenance"
      />

      <button
        type="button"
        onClick={onOpenNotifications}
        aria-label="Notifications"
        className="relative rounded-md p-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-primary" />
        )}
      </button>
    </header>
  );
}
