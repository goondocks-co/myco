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
  className?: string;
}

/** Content folded away behind one line: "Technical details", "and 3 more". */
export function Disclosure({ summary, children, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className={cn('flex flex-col gap-s2', className)}>
      <Collapsible.Trigger
        className={cn('inline-flex w-fit items-center gap-s1 rounded-chip t-small font-medium text-ink-2 hover:text-ink', focusRing)}
      >
        <ChevronRight aria-hidden className={cn('size-s4 text-muted transition-transform duration-120', open && 'rotate-90')} />
        {summary}
      </Collapsible.Trigger>
      <Collapsible.Content>{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
