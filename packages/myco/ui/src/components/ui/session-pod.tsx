import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SessionPodProps extends HTMLAttributes<HTMLDivElement> {
  active?: boolean;
  selected?: boolean;
}

const SessionPod = forwardRef<HTMLDivElement, SessionPodProps>(
  ({ className, active, selected, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'flex items-center gap-3 rounded-md bg-surface-container-low px-4 py-2.5 transition-all cursor-pointer',
          'hover:brightness-110 dark:hover:brightness-[1.04]',
          selected && 'shadow-[inset_0_0_12px_rgba(171,207,184,0.2)]',
          active && 'ring-1 ring-primary/30',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
SessionPod.displayName = 'SessionPod';

function PodTimestamp({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs text-on-surface-variant shrink-0', className)}>
      {children}
    </span>
  );
}

function PodTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-sans text-sm text-on-surface-variant truncate', className)}>
      {children}
    </span>
  );
}

function PodMeta({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs text-on-surface-variant/70 shrink-0', className)}>
      {children}
    </span>
  );
}

export { SessionPod, PodTimestamp, PodTitle, PodMeta };
