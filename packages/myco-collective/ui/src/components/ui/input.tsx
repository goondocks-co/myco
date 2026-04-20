import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'appearance-none flex h-11 w-full rounded-md border border-[var(--ghost-border)] bg-[var(--surface-container-lowest)] px-3 py-2 font-sans text-sm text-[var(--on-surface)] shadow-none transition-colors',
        'placeholder:text-[color-mix(in_srgb,var(--on-surface-variant),transparent_25%)]',
        'focus-visible:border-primary/40 focus-visible:outline-hidden',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
