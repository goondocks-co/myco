/**
 * Minimal headless dropdown menu. Built without a new Radix dep
 * since this is the only menu surface in the UI today; if we add
 * more we should migrate to @radix-ui/react-dropdown-menu.
 *
 * Click-outside closes the menu. Escape key closes the menu.
 * `disabled` items are not clickable and show a tooltip from the
 * native `title` attribute.
 */

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MoreVertical } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  disabledReason?: string;
  destructive?: boolean;
}

interface DropdownMenuProps {
  items: MenuItem[];
  /** Accessible label for the trigger button. */
  ariaLabel: string;
  /** Optional override for the trigger; defaults to a kebab icon button. */
  trigger?: ReactNode;
  align?: 'left' | 'right';
}

export function DropdownMenu({ items, ariaLabel, trigger, align = 'right' }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointer(event: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {trigger ?? <MoreVertical className="h-4 w-4" />}
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-50 mt-1 min-w-[12rem] rounded-md border border-outline-variant/30 bg-surface-container-highest p-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (item.disabled) return;
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center rounded-sm px-3 py-1.5 text-left text-sm transition-colors',
                'text-on-surface hover:bg-surface-container-high',
                'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent',
                item.destructive && !item.disabled && 'text-tertiary hover:bg-tertiary/10',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
