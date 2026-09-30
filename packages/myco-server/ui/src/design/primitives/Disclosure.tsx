import { useState, type ReactNode } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export interface DisclosureProps {
  /** The always-visible line that opens and closes the rest, such as "Technical details". */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Called as it opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** The summary fills its row as a block, for a summary of more than a few words, such as a turn of a conversation. */
  wide?: boolean;
  /** Classes for the summary's own button, as a wide summary's padding. */
  summaryClassName?: string;
  className?: string;
}

/** Content folded away behind one line: "Technical details", "and 3 more". What is folded is not rendered until it opens. */
export function Disclosure({ summary, children, defaultOpen = false, onOpenChange, wide = false, summaryClassName, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); }}
      className={cn('flex flex-col', !wide && 'gap-s2', className)}
    >
      <Collapsible.Trigger
        className={cn(
          wide
            ? 'flex min-h-tap w-full min-w-0 items-start gap-s2 rounded-control text-left text-ink hover:bg-surface-2'
            : 'inline-flex min-h-tap w-fit items-center gap-s1 rounded-chip t-small font-medium text-ink-2 hover:text-ink',
          focusRing,
          summaryClassName,
        )}
      >
        <ChevronRight aria-hidden className={cn('size-s4 shrink-0 text-muted transition-transform duration-120', wide && 'mt-[3px]', open && 'rotate-90')} />
        {wide ? <span className="flex min-w-0 flex-1 flex-col">{summary}</span> : summary}
      </Collapsible.Trigger>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
