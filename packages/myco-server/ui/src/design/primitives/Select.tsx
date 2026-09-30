import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fieldFrame, focusRing, overlaySurface } from '../lib/classes';
import { SearchableSelect, type SearchableSelectOption } from './SearchableSelect';

export const SelectRoot = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = forwardRef<
  ElementRef<typeof SelectPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(fieldFrame, focusRing, 'flex items-center justify-between gap-s2 text-left data-[placeholder]:text-muted [&>span]:truncate', className)}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown aria-hidden className="size-s4 shrink-0 text-muted" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = forwardRef<
  ElementRef<typeof SelectPrimitive.Content>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      sideOffset={4}
      className={cn(overlaySurface, 'relative z-50 max-h-[320px] min-w-[var(--radix-select-trigger-width)] overflow-hidden', className)}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-s1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = forwardRef<
  ElementRef<typeof SelectPrimitive.Item>,
  ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex h-control-sm cursor-default select-none items-center rounded-chip pl-s2 pr-s8 t-control text-ink-2 outline-none',
      'data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink data-[state=checked]:text-ink data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator className="absolute right-s2 inline-flex">
      <Check aria-hidden className="size-s4 text-primary" />
    </SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

export interface SelectOption {
  value: string;
  label: string;
  /** Extra words a searchable list matches against. */
  searchText?: string;
}

export interface SelectProps {
  /** The field's accessible name. */
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

/** Past this many options a select becomes searchable. */
export const SEARCHABLE_AFTER = 8;

/**
 * The one select. Every select in the dashboard looks and sizes the same; with
 * more than eight options it becomes a SearchableSelect.
 */
export function Select({ label, value, onValueChange, options, placeholder, disabled, className, id }: SelectProps) {
  if (options.length > SEARCHABLE_AFTER) {
    return (
      <SearchableSelect
        id={id}
        label={label}
        value={value}
        onValueChange={onValueChange}
        options={options as SearchableSelectOption[]}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
    );
  }
  return (
    <SelectRoot value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className={className}>
        <SelectValue placeholder={placeholder ?? label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
