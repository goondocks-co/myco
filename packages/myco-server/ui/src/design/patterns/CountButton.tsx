import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

const frame = 'inline-flex items-baseline gap-s2 rounded-control border border-line bg-surface-1 px-s3 py-[5px] t-small text-muted max-lg:min-h-tap max-lg:items-center';

export interface CountButtonProps {
  /** The number; absent for a control that sits in the row and counts nothing. */
  value?: number;
  /** What it counts, as in "tool calls". */
  children: ReactNode;
  /** A state colour for the number. */
  tone?: 'bad' | 'primary';
  /** Opens the view the count stands for; without it the count stands alone. */
  onClick?: () => void;
}

const TONE = { bad: 'text-bad', primary: 'text-primary' } as const;

/** One count of a page's row of counts, which opens its view. */
export function CountButton({ value, children, tone, onClick }: CountButtonProps) {
  const body = <>{value !== undefined && <><strong className={cn('font-semibold tabular-nums', tone === undefined ? 'text-ink' : TONE[tone])}>{value.toLocaleString()}</strong>{' '}</>}{children}</>;
  if (onClick === undefined) return <span className={frame}>{body}</span>;
  return <button type="button" onClick={onClick} className={cn(frame, 'hover:border-line-strong hover:text-ink', focusRing)}>{body}</button>;
}
