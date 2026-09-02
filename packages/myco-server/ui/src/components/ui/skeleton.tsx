import { cn } from '../../lib/cn';

/** A block the shape of content still on its way. Lists of them stand in for rows and cards until the read answers. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded bg-surface-container-high', className)} />;
}

/** `count` card-sized skeletons stacked, for a timeline or rail still loading. */
export function SkeletonList({ count = 3, className, label = 'Loading' }: { count?: number; className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('flex flex-col gap-3', className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full" />
      ))}
    </div>
  );
}
