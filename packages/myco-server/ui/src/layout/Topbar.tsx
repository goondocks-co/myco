import { LogOut } from 'lucide-react';
import { useLocation, useParams } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { postJson } from '../lib/api';
import { cn } from '../lib/cn';

const SERVER_PAGES: Record<string, string> = { '/projects': 'Projects', '/status': 'Status' };

/** Where this page's data lives: one Project, or the whole server. */
export function scopeOf(pathname: string): 'project' | 'server' {
  return pathname.startsWith('/p/') ? 'project' : 'server';
}

export function titleOf(pathname: string): string {
  if (pathname.startsWith('/p/')) return 'Overview';
  return SERVER_PAGES[pathname] ?? 'Not found';
}

async function signOut(): Promise<void> {
  try {
    await postJson('/auth/logout');
  } finally {
    window.location.assign('/');
  }
}

export function Topbar({ projectName, className }: { projectName?: string; className?: string }) {
  const location = useLocation();
  const params = useParams();
  const scope = scopeOf(location.pathname);
  const title = titleOf(location.pathname);
  const crumb = scope === 'project' ? (projectName ?? params.projectId ?? '') : 'Server';

  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-outline-variant/20 bg-surface-container/90 px-4 backdrop-blur',
        className,
      )}
    >
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 font-sans text-xs text-on-surface-variant">
        <span>{crumb}</span>
        <span className="mx-1">/</span>
        <span className="text-on-surface">{title}</span>
      </nav>
      <Badge variant="outline" className="font-mono text-[10px] uppercase tracking-wide">
        {scope === 'project' ? 'Project' : 'Server-wide'}
      </Badge>
      <button
        type="button"
        onClick={() => void signOut()}
        className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 font-sans text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
      >
        <LogOut className="h-3.5 w-3.5" />
        Sign out
      </button>
    </header>
  );
}
