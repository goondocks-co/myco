import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Dialog, DialogContent } from '../primitives/Dialog';

/** Opens and closes the search on ⌘K and Ctrl K, from anywhere on the page. */
export function useSearchShortcut(toggle: () => void): void {
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !event.isComposing) {
        event.preventDefault();
        latest.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export interface SearchCommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Where focus lands as the command opens: its search field. */
  initialFocus: RefObject<HTMLElement | null>;
  /** The field, its filters and the results. */
  children: ReactNode;
}

/**
 * The ⌘K search: a wide dialog near the top of the screen, holding one search
 * field, its filters beneath and the results led by what they say.
 */
export function SearchCommand({ open, onOpenChange, title, description, initialFocus, children }: SearchCommandProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        className="top-[10vh] max-h-[80vh] max-w-[640px] translate-y-0"
        onOpenAutoFocus={(event) => { event.preventDefault(); initialFocus.current?.focus(); }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
