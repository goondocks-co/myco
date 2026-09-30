import { forwardRef, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export const Tabs = TabsPrimitive.Root;

/** The row of tabs: an underline across the content's width. */
export const TabsList = forwardRef<ElementRef<typeof TabsPrimitive.List>, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.List ref={ref} className={cn('flex gap-s6 overflow-x-auto border-b border-line', className)} {...props} />
  ),
);
TabsList.displayName = 'TabsList';

export interface TabsTriggerProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  /** A count after the label, such as the number of spores. */
  count?: number;
}

/** One underline tab, with an optional count. */
export const TabsTrigger = forwardRef<ElementRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  ({ className, count, children, ...props }, ref) => (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        '-mb-px inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center gap-s2 border-b-2 border-transparent pb-s3 pt-s2 t-control font-medium text-muted transition-colors duration-120',
        'hover:text-ink-2 data-[state=active]:border-primary data-[state=active]:text-ink',
        focusRing,
        className,
      )}
      {...props}
    >
      {children}
      {count != null && <span className="t-meta font-normal text-faint">{count.toLocaleString()}</span>}
    </TabsPrimitive.Trigger>
  ),
);
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = forwardRef<ElementRef<typeof TabsPrimitive.Content>, ComponentPropsWithoutRef<typeof TabsPrimitive.Content>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Content ref={ref} className={cn('pt-s4 focus-visible:outline-none', className)} {...props} />
  ),
);
TabsContent.displayName = 'TabsContent';

export interface TabLinkItem {
  to: string;
  label: string;
  /** Whether this tab's page is the one open. */
  active: boolean;
  count?: number;
}

/**
 * Whether a row that scrolls sideways has more past its right edge: true while
 * its end is out of view, so the row can fade there and read as scrollable.
 */
function useMoreToTheRight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return undefined;
    const measure = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => { el.removeEventListener('scroll', measure); observer?.disconnect(); };
  }, []);
  return { ref, more };
}

/**
 * Underline tabs whose tabs are pages: each is a link, and the page open is
 * marked current. They read as the Tabs do, for sections that each have their
 * own address. On a screen too narrow for every tab the row scrolls in its own
 * box, and fades at its right edge while more tabs wait past it.
 */
export function TabLinks({ label, items, className }: { label: string; items: readonly TabLinkItem[]; className?: string }) {
  const { ref, more } = useMoreToTheRight<HTMLElement>();
  return (
    <div className={cn('relative', className)} data-tab-links="">
      <nav ref={ref} aria-label={label} className="flex gap-s6 overflow-x-auto border-b border-line">
        {items.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            aria-current={item.active ? 'page' : undefined}
            className={cn(
              '-mb-px inline-flex min-h-tap min-w-tap shrink-0 items-center justify-center gap-s2 border-b-2 pb-s3 pt-s2 t-control font-medium transition-colors duration-120',
              item.active ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink-2',
              focusRing,
            )}
          >
            {item.label}
            {item.count != null && <span className="t-meta font-normal text-faint">{item.count.toLocaleString()}</span>}
          </Link>
        ))}
      </nav>
      {more && <span aria-hidden data-more-tabs="" className="pointer-events-none absolute inset-y-0 right-0 w-s10 bg-linear-to-l from-bg to-transparent" />}
    </div>
  );
}
