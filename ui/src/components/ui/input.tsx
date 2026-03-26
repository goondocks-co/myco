import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md bg-surface-container-lowest border border-[var(--ghost-border)] px-3 py-1 font-sans text-sm text-on-surface shadow-none transition-colors',
          'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-on-surface',
          'placeholder:text-on-surface-variant/50',
          'focus-visible:outline-none focus-visible:border-primary/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
