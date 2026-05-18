import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import { Eyebrow } from './eyebrow';

/*
 * 2-up / 4-up metric tile used by Dashboard scope cards, Grove vault summary,
 * and Team queue tiles. Mirrors `.myco-vault-metric` from styles-v7.css.
 */
const metricCardVariants = cva(
  'flex flex-col gap-1 rounded-md bg-surface-container-lowest border border-[var(--ghost-border)] px-4 py-3',
  {
    variants: {
      tone: {
        default: '',
        sage: 'border-t-2 border-t-sage',
        ochre: 'border-t-2 border-t-ochre',
        terra: 'border-t-2 border-t-terracotta',
      },
    },
    defaultVariants: {
      tone: 'default',
    },
  },
);

export interface MetricCardProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof metricCardVariants> {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  /** When true, render the value in mono at 16px instead of italic serif at 22px. */
  mono?: boolean;
}

export const MetricCard = forwardRef<HTMLDivElement, MetricCardProps>(
  ({ label, value, sub, tone, mono = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(metricCardVariants({ tone }), className)}
      {...props}
    >
      <Eyebrow size="sm">{label}</Eyebrow>
      <div
        className={cn(
          mono
            ? 'font-mono text-base leading-tight text-on-surface'
            : 'myco-display-md text-on-surface',
        )}
      >
        {value}
      </div>
      {sub != null && (
        <div className="font-mono text-[10px] text-outline">{sub}</div>
      )}
    </div>
  ),
);
MetricCard.displayName = 'MetricCard';

export { metricCardVariants };
