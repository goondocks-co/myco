import { cn } from '../../lib/cn';

/** A block the shape of content on its way. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn('block rounded-chip bg-surface-3 motion-safe:animate-pulse', className)} />;
}

export interface LoadingStateProps {
  /** The page's own shape: two-line rows, cards, or a reading page. */
  shape?: 'rows' | 'cards' | 'reading';
  count?: number;
  /** What is loading, for assistive technology. */
  label: string;
  className?: string;
}

/** Skeletons in the shape of the page that is loading. */
export function LoadingState({ shape = 'rows', count = 5, label, className }: LoadingStateProps) {
  const items = Array.from({ length: count }, (_, i) => i);
  return (
    <div role="status" aria-label={label} className={cn('flex flex-col', shape === 'cards' && 'gap-s3', className)}>
      {shape === 'rows' && items.map((i) => (
        <span key={i} className="flex min-h-row flex-col justify-center gap-s2 border-b border-line px-s4">
          <Skeleton className="h-s4 w-3/5" />
          <Skeleton className="h-s3 w-2/5" />
        </span>
      ))}
      {shape === 'cards' && items.map((i) => <Skeleton key={i} className="h-[96px] w-full rounded-card" />)}
      {shape === 'reading' && (
        <span className="flex max-w-[var(--measure)] flex-col gap-s3">
          <Skeleton className="h-s8 w-3/4" />
          <Skeleton className="h-s4 w-1/3" />
          {items.map((i) => <Skeleton key={i} className="h-s4 w-full" />)}
        </span>
      )}
    </div>
  );
}
