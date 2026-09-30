import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';

const DAY_MS = 86_400_000;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** A day in words relative to now: "Today", "Yesterday", else "Thursday, September 24", with the year when it is not this one. */
export function dayLabel(at: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export interface DayGroupProps {
  /** The day in words; `dayLabel` makes one from a time. */
  label: string;
  /** How many items the day holds, when the count helps. */
  count?: number;
  children: ReactNode;
  className?: string;
}

/** One day of a list: a quiet separator line naming the day, then its rows. */
export function DayGroup({ label, count, children, className }: DayGroupProps) {
  return (
    <section aria-label={label} className={cn('flex flex-col', className)}>
      <h3 className="flex items-baseline gap-s2 border-b border-line bg-surface-2 px-s4 py-s2 t-small font-medium text-muted">
        {label}
        {count != null && <span className="t-meta font-normal">{count.toLocaleString()}</span>}
      </h3>
      {children}
    </section>
  );
}
