import { Sparkline } from './sparkline';
import { cn } from '../../lib/cn';

/* ---------- Types ---------- */

export type StatAccent = 'sage' | 'ochre' | 'terracotta' | 'outline';

export interface StatCardProps {
  label: string;
  value: string;
  sublabel?: string;
  accent: StatAccent;
  sparklineData?: number[];
  className?: string;
}

/* ---------- Constants ---------- */

const ACCENT_BORDER: Record<StatAccent, string> = {
  sage: 'border-t-sage',
  ochre: 'border-t-ochre',
  terracotta: 'border-t-terracotta',
  outline: 'border-t-outline',
};

const ACCENT_VALUE: Record<StatAccent, string> = {
  sage: 'text-sage',
  ochre: 'text-ochre',
  terracotta: 'text-terracotta',
  outline: 'text-on-surface',
};

/* ---------- Component ---------- */

export function StatCard({ label, value, sublabel, accent, sparklineData, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-outline-variant/10 bg-surface-container/60 p-4 border-t-2 transition-[border-color,background-color] duration-200 hover:border-outline-variant/25 hover:bg-surface-container/80',
        ACCENT_BORDER[accent],
        className,
      )}
    >
      <p className="font-mono text-[10px] uppercase tracking-wider text-outline mb-2">
        {label}
      </p>
      <div className="flex items-end justify-between gap-2">
        <p className={cn('font-serif text-2xl font-bold', ACCENT_VALUE[accent])}>
          {value}
        </p>
        {sparklineData && sparklineData.length >= 2 && (
          <Sparkline data={sparklineData} width={80} height={28} className="opacity-60" />
        )}
      </div>
      {sublabel && (
        <p className="font-mono text-[10px] text-outline mt-1">{sublabel}</p>
      )}
    </div>
  );
}
