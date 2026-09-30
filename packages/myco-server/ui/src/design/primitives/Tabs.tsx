import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
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
        '-mb-px inline-flex shrink-0 items-center gap-s2 border-b-2 border-transparent pb-s3 pt-s2 t-control font-medium text-muted transition-colors duration-120',
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
