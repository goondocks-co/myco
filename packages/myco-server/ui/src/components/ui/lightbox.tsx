import { useCallback, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

interface LightboxProps {
  /** Every image in the gallery. */
  images: { src: string; alt?: string }[];
  /** The one shown. */
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

/** A full-screen view of one image in a gallery: focus moves in on open, stays among its controls, and returns to where it came from on close. */
export function Lightbox({ images, index, onClose, onNavigate }: LightboxProps) {
  const current = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1);
      if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1);
      if (e.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (first === undefined || last === undefined) return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    },
    [onClose, onNavigate, index, hasPrev, hasNext],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!current) return null;

  const control = 'absolute rounded-full bg-surface-container-high/80 p-2 text-on-surface transition-colors hover:bg-surface-container-highest z-10';

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Image" className="fixed inset-0 z-50 flex items-center justify-center bg-surface-dim/90 backdrop-blur-xs" onClick={onClose}>
      <button ref={closeButton} type="button" aria-label="Close" onClick={onClose} className={`${control} top-4 right-4`}>
        <X className="h-5 w-5" />
      </button>
      {images.length > 1 && (
        <span className="absolute top-4 left-1/2 -translate-x-1/2 font-mono text-xs text-on-surface/60 z-10">
          {index + 1} / {images.length}
        </span>
      )}
      {hasPrev && (
        <button type="button" aria-label="Previous image" onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }} className={`${control} left-4`}>
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      {hasNext && (
        <button type="button" aria-label="Next image" onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }} className={`${control} right-4`}>
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
      <img src={current.src} alt={current.alt} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
