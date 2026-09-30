import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  /** What is empty, in one line: "Nothing today". */
  title: ReactNode;
  /** The next step, usually a Link: "Yesterday's work →". */
  action?: ReactNode;
  className?: string;
}

/** An empty list says so in one line and offers the next step. */
export function EmptyState({ title, action, className }: EmptyStateProps) {
  return (
    <div role="status" className={cn('flex flex-wrap items-baseline gap-x-s3 gap-y-s1 py-s6 t-body text-muted', className)}>
      <span>{title}</span>
      {action}
    </div>
  );
}
