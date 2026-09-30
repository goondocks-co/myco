import { Fragment, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing, tapTarget } from '../lib/classes';

export interface Crumb {
  label: ReactNode;
  to: string;
}

export interface BreadcrumbsProps {
  /** The pages above this one, outermost first. */
  items: readonly Crumb[];
  className?: string;
}

/** The way back up from a record: each page above it, outermost first, as links a finger can hit. */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-s1 t-small text-muted">
        {items.map((item, i) => (
          <Fragment key={item.to + String(i)}>
            {i > 0 && <li aria-hidden><ChevronRight className="size-s4" /></li>}
            <li>
              <RouterLink to={item.to} className={cn(tapTarget, 'justify-center rounded-chip hover:text-ink hover:underline', focusRing)}>
                {item.label}
              </RouterLink>
            </li>
          </Fragment>
        ))}
      </ol>
    </nav>
  );
}
