import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** SVG viewBox dimension for the gauge circle. */
const GAUGE_SIZE = 80;

/** Stroke width for the gauge arc. */
const GAUGE_STROKE = 6;

/** Radius derived from size and stroke. */
const GAUGE_RADIUS = (GAUGE_SIZE - GAUGE_STROKE) / 2;

/** Circumference of the full circle. */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

/** Threshold below which the gauge shows sage (healthy). */
const HEALTHY_THRESHOLD = 0.6;

/** Threshold below which the gauge shows ochre (moderate). */
const MODERATE_THRESHOLD = 0.85;

/* ---------- Helpers ---------- */

/** Determine the gauge color based on the fill ratio. */
function gaugeColor(ratio: number): string {
  if (ratio < HEALTHY_THRESHOLD) return 'var(--primary)';
  if (ratio < MODERATE_THRESHOLD) return 'var(--secondary)';
  return 'var(--tertiary)';
}

/* ---------- Component ---------- */

interface MetricGaugeProps {
  /** Value between 0 and 1. */
  value: number;
  /** Display label below the gauge. */
  label: string;
  /** Formatted value string shown in the center. */
  displayValue: string;
  className?: string;
}

export function MetricGauge({ value, label, displayValue, className }: MetricGaugeProps) {
  const clampedValue = Math.min(1, Math.max(0, value));
  const offset = GAUGE_CIRCUMFERENCE * (1 - clampedValue);
  const color = gaugeColor(clampedValue);

  return (
    <div className={cn('flex flex-col items-center gap-1.5', className)}>
      <svg
        width={GAUGE_SIZE}
        height={GAUGE_SIZE}
        viewBox={`0 0 ${GAUGE_SIZE} ${GAUGE_SIZE}`}
        className="-rotate-90"
      >
        {/* Background track */}
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={GAUGE_RADIUS}
          fill="none"
          stroke="var(--surface-container-high)"
          strokeWidth={GAUGE_STROKE}
        />
        {/* Value arc */}
        <circle
          cx={GAUGE_SIZE / 2}
          cy={GAUGE_SIZE / 2}
          r={GAUGE_RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={GAUGE_STROKE}
          strokeLinecap="round"
          strokeDasharray={GAUGE_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      {/* Center value overlay */}
      <div className="relative -mt-[60px] mb-[14px] flex flex-col items-center justify-center">
        <span className="font-mono text-sm font-semibold text-on-surface">{displayValue}</span>
      </div>
      <span className="font-sans text-xs text-on-surface-variant">{label}</span>
    </div>
  );
}
