import { type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-sm px-2 py-0.5 font-sans text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-container-high text-primary',
        secondary: 'bg-surface-container-high text-on-surface-variant',
        destructive: 'bg-surface-container-high text-tertiary',
        warning: 'bg-surface-container-high text-secondary',
        outline: 'border border-[var(--ghost-border)] text-on-surface-variant',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
