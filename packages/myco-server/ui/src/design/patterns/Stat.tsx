import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { Sparkline } from '../primitives/Sparkline';

export interface StatProps {
  /** What the number is, as in "What it cost". */
  label: ReactNode;
  value: ReactNode;
  /** One line of context, as in "the agents' own estimate; 3 runs reported none". */
  context?: ReactNode;
  /** Colours the value only when it states a state. */
  tone?: 'ok' | 'warn' | 'bad';
  /** A Health measure's recent values. */
  trend?: { data: readonly number[]; label: string };
  /** Makes the stat a link to where the number comes from. */
  to?: string;
  className?: string;
}

const TONE = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad' } as const;

/** A number with its label and one line of context. */
export function Stat({ label, value, context, tone, trend, to, className }: StatProps) {
  const body = (
    <>
      <span className="t-small text-muted">{label}</span>
      <span className="flex items-end justify-between gap-s3">
        <span className={cn('t-display tabular-nums text-ink', tone && TONE[tone])}>{value}</span>
        {trend && trend.data.length >= 2 && <Sparkline data={trend.data} label={trend.label} />}
      </span>
      {context != null && <span className="t-small text-muted">{context}</span>}
    </>
  );
  const classes = cn('flex min-w-0 flex-col gap-s1 rounded-card border border-line bg-surface-1 p-s4', className);
  if (to != null) return <Link to={to} className={cn(classes, 'transition-colors duration-120 hover:bg-surface-2', focusRing)}>{body}</Link>;
  return <div className={classes}>{body}</div>;
}
