import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Filter } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface FilterPillProps {
  /** Number of filters currently active. When > 0, a count badge appears. */
  activeCount: number;
  /** Content rendered inside the popover when open (filter form, checkboxes, etc.). */
  children: ReactNode;
  /** Optional label override. Defaults to "Filter". */
  label?: string;
  className?: string;
}

export function FilterPill({ activeCount, children, label = 'Filter', className }: FilterPillProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn('relative inline-flex', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(
          'inline-flex items-center gap-2 rounded-full border border-outline-variant/30 bg-surface-container-high px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container transition-colors',
          activeCount > 0 && 'border-primary/40',
        )}
      >
        <Filter className="h-3 w-3" />
        <span>{label}</span>
        {activeCount > 0 && (
          <span
            aria-label={`${activeCount} active filter${activeCount === 1 ? '' : 's'}`}
            className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-on-primary"
          >
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`${label} options`}
          className="absolute right-0 top-full z-30 mt-2 min-w-[240px] rounded-md border border-outline-variant/30 bg-surface-container-high shadow-lg p-3"
        >
          {children}
        </div>
      )}
    </div>
  );
}
