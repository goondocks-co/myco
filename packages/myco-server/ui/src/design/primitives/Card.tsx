import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `flush` drops the padding, for a card whose rows run edge to edge. */
  padding?: 'normal' | 'flush';
}

/** A flat panel on the page: surface-1, one line, the card radius. */
export const Card = forwardRef<HTMLDivElement, CardProps>(({ padding = 'normal', className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-card border border-line bg-surface-1', padding === 'normal' && 'p-s4', className)} {...props} />
));
Card.displayName = 'Card';
