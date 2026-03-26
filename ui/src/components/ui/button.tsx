import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md font-sans text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:
          'bg-gradient-to-br from-primary to-primary-container text-on-primary shadow-sm hover:shadow-[0_0_0_1px_rgba(171,207,184,0.4)]',
        destructive:
          'bg-gradient-to-br from-tertiary to-tertiary-container text-on-surface shadow-sm hover:shadow-[0_0_0_1px_rgba(255,180,161,0.4)]',
        outline:
          'border border-[var(--ghost-border)] bg-transparent shadow-sm hover:bg-surface-container-high hover:text-on-surface',
        secondary:
          'border border-outline-variant/20 bg-transparent hover:bg-surface-container-high text-on-surface',
        ghost: 'hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
