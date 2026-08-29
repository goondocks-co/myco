import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/*
 * 28px mono-numbered circle used to head each step of a guided flow.
 */

export interface StepCircleProps extends HTMLAttributes<HTMLSpanElement> {
  number: number;
  /** Edge length in pixels; defaults to 28 per v7. */
  size?: number;
}

export const StepCircle = forwardRef<HTMLSpanElement, StepCircleProps>(
  ({ number, size = 28, className, style, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-full bg-surface-container-high text-on-surface font-mono font-semibold shrink-0',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round((size * 12) / 28),
        ...style,
      }}
      {...props}
    >
      {number}
    </span>
  ),
);
StepCircle.displayName = 'StepCircle';
