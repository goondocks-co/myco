import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 select-none items-center justify-center gap-s2 whitespace-nowrap rounded-control border font-medium',
    'transition-colors duration-120 disabled:pointer-events-none disabled:opacity-50',
    focusRing,
  ),
  {
    variants: {
      variant: {
        primary: 'border-primary bg-primary text-on-primary hover:bg-[color-mix(in_srgb,var(--primary)_88%,var(--ink))]',
        secondary: 'border-line-strong bg-surface-2 text-ink hover:bg-surface-3',
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink',
        danger: 'border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-bad-bg text-bad hover:bg-[color-mix(in_srgb,var(--bad)_20%,transparent)]',
      },
      size: {
        sm: 'h-control-sm px-s3 t-small',
        md: 'h-control px-s4 t-control',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button while an action is in flight. */
  pending?: boolean;
  /** An icon before the label. */
  icon?: ReactNode;
}

/** The one button. Variants: primary, secondary (the default), ghost, danger; sizes sm and md. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pending = false, icon, disabled, children, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {pending ? <Loader2 aria-hidden className="size-s4 animate-spin" /> : icon}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children'> {
  /** What the button does, read by assistive technology and shown as its tooltip. */
  label: string;
  children: ReactNode;
}

/** A square button holding only an icon; the label is required because nothing else names it. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, className, size, variant = 'ghost', children, ...props }, ref) => (
    <Button
      ref={ref}
      aria-label={label}
      title={label}
      variant={variant}
      size={size}
      className={cn(size === 'sm' ? 'w-control-sm px-0' : 'w-control px-0', className)}
      {...props}
    >
      {children}
    </Button>
  ),
);
IconButton.displayName = 'IconButton';
