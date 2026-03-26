import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const surfaceVariants = cva('rounded-md transition-colors', {
  variants: {
    level: {
      lowest: 'bg-surface-container-lowest',
      low: 'bg-surface-container-low',
      default: 'bg-surface-container',
      high: 'bg-surface-container-high',
      highest: 'bg-surface-container-highest',
      bright: 'bg-surface-bright',
    },
    interactive: {
      true: 'cursor-pointer hover:brightness-[1.15]',
      false: '',
    },
    ghostBorder: {
      true: 'border border-[var(--ghost-border)]',
      false: '',
    },
    glass: {
      true: 'backdrop-blur-xl bg-surface-variant/60',
      false: '',
    },
    glow: {
      true: 'shadow-[inset_0_0_12px_rgba(171,207,184,0.2)]',
      false: '',
    },
  },
  defaultVariants: {
    level: 'low',
    interactive: false,
    ghostBorder: false,
    glass: false,
    glow: false,
  },
});

export interface SurfaceProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof surfaceVariants> {}

const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  ({ className, level, interactive, ghostBorder, glass, glow, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          surfaceVariants({ level, interactive, ghostBorder, glass, glow }),
          className,
        )}
        {...props}
      />
    );
  },
);
Surface.displayName = 'Surface';

export { Surface, surfaceVariants };
