import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

/*
 * v7's signature card chrome: a 2px coloured stripe on top of the card.
 * Reproduces `.myco-grove-id-card`, `.myco-vault-metric.tone-*`, and
 * `.myco-team-queue-tile.tone-*` from styles-v7.css.
 *
 * The base style mirrors the v7 reference: surface-container-low background,
 * outline-variant border, 12px radius. Use the `accent` prop to pick the
 * top-stripe tone; the rest of the border is rendered with the same width to
 * keep all four sides aligned (v7 uses `border` + `border-top: 2px ...` which
 * leaves a 1-pixel sit at the top edge — we match that by setting the
 * top-stripe with `border-top-width: 2px` while the other three sides stay 1px).
 */
const accentSurfaceVariants = cva(
  'rounded-xl bg-surface-container-low border border-outline-variant',
  {
    variants: {
      accent: {
        sage: 'border-t-2 border-t-sage',
        ochre: 'border-t-2 border-t-ochre',
        terra: 'border-t-2 border-t-terracotta',
        outline: 'border-t-2 border-t-outline-variant',
      },
      padded: {
        true: 'p-4',
        false: '',
      },
    },
    defaultVariants: {
      accent: 'sage',
      padded: false,
    },
  },
);

export interface AccentSurfaceProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof accentSurfaceVariants> {}

export const AccentSurface = forwardRef<HTMLDivElement, AccentSurfaceProps>(
  ({ className, accent, padded, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(accentSurfaceVariants({ accent, padded }), className)}
      {...props}
    />
  ),
);
AccentSurface.displayName = 'AccentSurface';

export { accentSurfaceVariants };
