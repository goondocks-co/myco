import { type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export interface SlideOverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The bar's words, which also name the panel, as in "Learning run · Myco". */
  title: ReactNode;
  children: ReactNode;
  /** Marks the panel for the screen checks and tests. */
  'data-testid'?: string;
}

/**
 * A record opened beside its list: a panel from the right edge over a scrim,
 * its own screen on a phone. Radix traps focus inside it and returns focus to
 * what opened it; Escape and the close button both close it.
 */
export function SlideOver({ open, onOpenChange, title, children, ...rest }: SlideOverProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          data-slide-over=""
          data-testid={rest['data-testid']}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface-1 text-ink shadow-[var(--shadow-overlay)]',
            'sm:max-w-slide-over sm:border-l sm:border-line-strong',
          )}
        >
          <div className="flex h-row-tight shrink-0 items-center gap-s3 border-b border-line px-s4 sm:px-s6">
            {/* The bar names the panel; the record's own headline is the panel's heading. */}
            <DialogPrimitive.Title asChild>
              <p className="min-w-0 flex-1 truncate t-small font-medium text-muted">{title}</p>
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close"
              className={cn('inline-flex size-control-sm shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink', focusRing)}
            >
              <X aria-hidden className="size-s4" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-s4 py-s5 sm:px-s6">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
