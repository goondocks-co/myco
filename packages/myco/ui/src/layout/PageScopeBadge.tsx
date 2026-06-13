import { useLocation } from 'react-router-dom';
import { scopeForPath } from '../lib/selection';
import { useProjectSelection } from '../hooks/use-project-selection';
import { cn } from '../lib/cn';

/**
 * Page-scope indicator. Project pages render nothing (the switcher already
 * names the project). Grove pages signal that the page acts on every project
 * in the Grove; machine pages signal machine-wide. Colors mirror
 * OperationsScopePill (grove = secondary, machine = tertiary).
 */
export function PageScopeBadge() {
  const location = useLocation();
  const selection = useProjectSelection();
  const scope = scopeForPath(location.pathname);
  if (scope === 'project') return null;

  if (scope === 'grove') {
    const grove = selection?.grove;
    const count = grove?.projects.length ?? 0;
    return (
      <Badge
        className="border-secondary/50 bg-secondary/10 text-secondary"
        dot="bg-secondary"
        title="This page acts on every project in the Grove"
      >
        Grove-wide{grove ? ` · ${grove.name}` : ''}{count ? ` · ${count} ${count === 1 ? 'project' : 'projects'}` : ''}
      </Badge>
    );
  }

  return (
    <Badge
      className="border-tertiary/50 bg-tertiary/10 text-tertiary"
      dot="bg-tertiary"
      title="This page acts across every Grove on this machine"
    >
      Machine-wide
    </Badge>
  );
}

function Badge({
  children, className, dot, title,
}: { children: React.ReactNode; className: string; dot: string; title: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
        className,
      )}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
      {children}
    </span>
  );
}
