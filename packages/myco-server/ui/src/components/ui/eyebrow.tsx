import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const eyebrowVariants = cva('inline-flex items-center myco-eyebrow', {
  variants: {
    tone: {
      default: 'text-outline',
      sage: 'text-sage',
      ochre: 'text-ochre',
      terra: 'text-terracotta',
      outline: 'text-outline',
    },
    size: {
      sm: 'myco-eyebrow-sm',
      md: 'myco-eyebrow',
    },
  },
  defaultVariants: {
    tone: 'default',
    size: 'md',
  },
});

export interface EyebrowProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof eyebrowVariants> {}

export const Eyebrow = forwardRef<HTMLSpanElement, EyebrowProps>(
  ({ className, tone, size, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(eyebrowVariants({ tone, size }), className)}
      {...props}
    />
  ),
);
Eyebrow.displayName = 'Eyebrow';

export { eyebrowVariants };
