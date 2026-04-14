import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'rounded-md border border-[var(--ghost-border)] bg-card text-card-foreground',
        className,
      )}
      {...props}
    />
  ),
);

Card.displayName = 'Card';
