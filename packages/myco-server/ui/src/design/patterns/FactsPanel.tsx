import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface FactRowProps {
  term: ReactNode;
  children: ReactNode;
  /** Sets the value in the code font, for a path or command. */
  mono?: boolean;
}

/** One key/value row of a facts list. */
export function FactRow({ term, children, mono = false }: FactRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-s4 py-s2">
      <dt className="shrink-0 t-small text-muted">{term}</dt>
      <dd className={cn('min-w-0 text-right text-ink-2', mono ? 't-mono break-all' : 't-small')}>{children}</dd>
    </div>
  );
}

export interface FactsPanelProps {
  title?: ReactNode;
  /** FactRows. */
  children: ReactNode;
  /** Copy buttons and similar, under the facts. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The facts column: key/value rows and the copy actions. The only place a raw
 * id may appear, which is why it carries `data-facts` for the screen checks.
 */
export function FactsPanel({ title, children, actions, className }: FactsPanelProps) {
  return (
    <aside data-facts="" className={cn('flex min-w-0 flex-col gap-s2 rounded-card border border-line bg-surface-1 p-s4', className)}>
      {title != null && <h3 className="t-h3 text-ink">{title}</h3>}
      <dl className="flex flex-col divide-y divide-line">{children}</dl>
      {actions != null && <div className="flex flex-wrap gap-s2 pt-s2">{actions}</div>}
    </aside>
  );
}
