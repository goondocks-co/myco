import { Link } from 'react-router-dom';
import { GitBranch } from 'lucide-react';
import { cn } from '../../lib/cn';
import { gitIdentityInitials, type GitIdentity } from '../../hooks/use-git-identity';

export interface GitIdentityPillProps {
  data: GitIdentity | undefined;
  isPending: boolean;
  isError: boolean;
  to?: string;
  className?: string;
}

export function GitIdentityPill({ data, isPending, isError, to, className }: GitIdentityPillProps) {
  if (isPending || isError || !data) {
    return (
      <button
        type="button"
        disabled
        data-testid="git-identity-pill"
        className={cn(
          'inline-flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 text-on-surface-variant',
          className,
        )}
        title={isError ? 'Failed to load git state' : 'Loading git state'}
      >
        <GitBranch className="h-3 w-3" />
        <span className="font-mono text-xs">—</span>
      </button>
    );
  }

  const initials = gitIdentityInitials(data.author);
  const title = `${data.author} <${data.author_email}> · ${data.branch}${data.dirty ? ' (dirty)' : ''}`;
  const content = (
    <>
      <GitBranch className="h-3 w-3 text-on-surface-variant" />
      <div className="flex flex-col items-start leading-tight">
        <span className="font-mono text-xs text-on-surface">{data.branch}</span>
        <span className="font-mono text-[10px] text-on-surface-variant inline-flex items-center gap-1">
          {data.dirty && (
            <span title="working tree dirty" className="text-secondary">●</span>
          )}
          {data.ahead > 0 && <span title="ahead of upstream">↑{data.ahead}</span>}
          {data.behind > 0 && <span title="behind upstream">↓{data.behind}</span>}
          <span>{data.author}</span>
        </span>
      </div>
      <span className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/20 font-sans text-[10px] font-semibold text-primary">
        {initials}
      </span>
    </>
  );
  const classes = cn(
    'inline-flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 no-underline hover:bg-surface-container-high transition-colors',
    className,
  );

  if (to) {
    return (
      <Link
        to={to}
        title={`${title}. Open release provenance settings.`}
        data-testid="git-identity-pill"
        className={classes}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type="button"
      title={title}
      data-testid="git-identity-pill"
      className={classes}
    >
      {content}
    </button>
  );
}
