import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-2xl border border-[rgba(255,231,208,0.12)] bg-[rgba(255,248,240,0.05)] px-4 text-sm text-[#fff4e8] outline-none transition-colors placeholder:text-[#9e8b7e] focus:border-[rgba(247,179,106,0.55)]',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';
