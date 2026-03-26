import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/**
 * Tonal surface container — replaces Card for the redesign.
 *
 * Levels map to Material 3 surface container hierarchy:
 * - lowest:  darkest background (graph canvas, deep wells)
 * - low:     default content container (replaces bg-card)
 * - default: standard surface
 * - high:    raised panels, popovers
 *
 * `glass` enables a frosted-glass effect for overlays/inspectors.
 */

const LEVEL_CLASSES: Record<string, string> = {
  lowest: 'bg-surface-container-lowest',
  low: 'bg-surface-container-low',
  default: 'bg-surface-container',
  high: 'bg-surface-container-high',
};

const GLASS_CLASS = 'bg-surface-container-high/80 backdrop-blur-md';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  level?: 'lowest' | 'low' | 'default' | 'high';
  glass?: boolean;
}

const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, level = 'default', glass = false, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-lg',
          glass ? GLASS_CLASS : LEVEL_CLASSES[level],
          className,
        )}
        {...props}
      />
    );
  },
);
Surface.displayName = 'Surface';

export { Surface };
