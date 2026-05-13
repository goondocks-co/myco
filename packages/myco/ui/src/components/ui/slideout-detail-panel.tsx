import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Surface } from './surface';
import { cn } from '../../lib/cn';

export interface SlideoutDetailPanelProps {
  open: boolean;
  onClose: () => void;
  widthPx?: number;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
}

export function SlideoutDetailPanel({
  open,
  onClose,
  widthPx = 480,
  children,
  ariaLabel = 'Detail panel',
  className,
}: SlideoutDetailPanelProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Surface
      glass
      role="dialog"
      aria-label={ariaLabel}
      className={cn(
        'fixed top-3 right-3 bottom-3 z-30 flex flex-col shadow-lg border border-outline-variant/15 rounded-md max-w-[calc(100vw-1.5rem)]',
        className,
      )}
      style={{ width: widthPx }}
    >
      <div className="flex justify-end px-3 pt-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="shrink-0 rounded-md p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 pb-5 pt-2">{children}</div>
    </Surface>
  );
}
