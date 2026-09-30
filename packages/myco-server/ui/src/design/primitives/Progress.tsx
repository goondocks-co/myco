import { cn } from '../../lib/cn';

export interface ProgressProps {
  /** How many are done. */
  done: number;
  /** How many there are. */
  total: number;
  /** Names the measure for assistive technology, as in "Plan items done". */
  label: string;
  className?: string;
}

/** How far a list of items has got: a thin bar, with the count in words for assistive technology. */
export function Progress({ done, total, label, className }: ProgressProps) {
  const share = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total}`}
      className={cn('block h-s1 w-full overflow-hidden rounded-pill bg-surface-3', className)}
    >
      <span className="block h-full rounded-pill bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}
