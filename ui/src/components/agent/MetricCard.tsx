import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Sparkline } from '../ui/sparkline';

/* ---------- Component ---------- */

interface MetricCardProps {
  label: string;
  value: string;
  /** Optional sparkline data points. */
  sparklineData?: number[];
  /** Optional gauge/icon to render inline. */
  children?: ReactNode;
  className?: string;
}

export function MetricCard({ label, value, sparklineData, children, className }: MetricCardProps) {
  return (
    <div
      className={cn(
        'rounded-md bg-surface-container-low p-3 flex flex-col gap-2',
        className,
      )}
    >
      <span className="font-sans text-xs text-on-surface-variant uppercase tracking-wide">
        {label}
      </span>
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-lg font-semibold text-on-surface">{value}</span>
        {children}
      </div>
      {sparklineData && sparklineData.length >= 2 && (
        <Sparkline data={sparklineData} width={160} height={28} className="mt-1 opacity-80" />
      )}
    </div>
  );
}
