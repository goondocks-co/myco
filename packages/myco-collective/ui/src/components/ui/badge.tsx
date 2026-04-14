import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.2em]',
  {
    variants: {
      variant: {
        outline: 'border-[var(--ghost-border)] bg-transparent text-on-surface-variant',
        accent: 'border-transparent bg-primary/15 text-primary',
        subtle: 'border-[var(--ghost-border)] bg-surface-container-low text-on-surface-variant',
        danger: 'border-tertiary/25 bg-tertiary/10 text-tertiary',
      },
    },
    defaultVariants: {
      variant: 'outline',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
