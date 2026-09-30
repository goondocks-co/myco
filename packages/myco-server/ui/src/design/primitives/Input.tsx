import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fieldFrame, focusRing } from '../lib/classes';

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** A single-line text field at control height. */
export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, type = 'text', ...props }, ref) => (
  <input ref={ref} type={type} className={cn(fieldFrame, focusRing, className)} {...props} />
));
Input.displayName = 'Input';

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** A multi-line text field; it grows with its rows, never below three. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, rows = 3, ...props }, ref) => (
  <textarea
    ref={ref}
    rows={rows}
    className={cn(fieldFrame, focusRing, 'h-auto min-h-[calc(var(--control-h)*2)] py-s2 t-body', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** The field's accessible name; also its placeholder unless one is given. */
  label: string;
  /** A keyboard hint at the right edge, such as "/" or "⌘K". */
  hint?: ReactNode;
}

/** A search field that fills its row: a leading glass, the query, and an optional keyboard hint. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ label, hint, className, placeholder, ...props }, ref) => (
    <div className={cn('relative flex min-w-0 flex-1 items-center', className)}>
      <Search aria-hidden className="pointer-events-none absolute left-s3 size-s4 text-muted" />
      <input
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        data-filter-input=""
        className={cn(fieldFrame, focusRing, 'pl-[calc(var(--s-3)+24px)]', hint != null && 'pr-s12', '[&::-webkit-search-cancel-button]:hidden')}
        {...props}
      />
      {hint != null && (
        <kbd className="pointer-events-none absolute right-s3 rounded-chip border border-line-strong px-s1 t-meta text-faint">{hint}</kbd>
      )}
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';
