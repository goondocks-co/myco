import { forwardRef, type HTMLAttributes, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

export type RowAccent = 'sage' | 'ochre' | 'terra';

export interface RowProps extends HTMLAttributes<HTMLDivElement> {
  accent?: RowAccent;
  isActive?: boolean;
  /** Keyboard-nav focus highlight, distinct from `isActive` selection. */
  isCursor?: boolean;
  onClick?: () => void;
  interactive?: boolean;
}

const ACTIVE_STRIPE: Record<RowAccent, string> = {
  sage: 'bg-sage/[0.08] shadow-[inset_2px_0_0_var(--sage)]',
  ochre: 'bg-ochre/[0.08] shadow-[inset_2px_0_0_var(--ochre)]',
  terra: 'bg-terracotta/[0.08] shadow-[inset_2px_0_0_var(--terracotta)]',
};

const CURSOR_RING: Record<RowAccent, string> = {
  sage: 'ring-1 ring-inset ring-sage/40',
  ochre: 'ring-1 ring-inset ring-ochre/40',
  terra: 'ring-1 ring-inset ring-terracotta/40',
};

export const Row = forwardRef<HTMLDivElement, RowProps>(
  ({ accent = 'sage', isActive = false, isCursor = false, interactive, onClick, className, children, onKeyDown, ...props }, ref) => {
    const isInteractive = interactive ?? typeof onClick === 'function';

    function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
      if (isInteractive && onClick && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        onClick();
      }
      onKeyDown?.(e);
    }

    return (
      <div
        ref={ref}
        onClick={isInteractive ? onClick : undefined}
        onKeyDown={isInteractive ? handleKeyDown : onKeyDown}
        tabIndex={isInteractive ? 0 : undefined}
        role={isInteractive ? 'row' : undefined}
        aria-selected={isInteractive ? isActive : undefined}
        data-active={isActive || undefined}
        data-cursor={isCursor || undefined}
        className={cn(
          'relative border-b border-[var(--ghost-border)] last:border-b-0 px-4 py-3 transition-colors duration-100',
          isInteractive && 'cursor-pointer hover:bg-surface-container focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sage/40',
          isActive && ACTIVE_STRIPE[accent],
          isCursor && !isActive && CURSOR_RING[accent],
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  },
);
Row.displayName = 'Row';
