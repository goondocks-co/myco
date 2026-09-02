import { cn } from '../../lib/cn';

export interface SparklineProps {
  /** Bucket values; bar heights scale to max(data). Render order: index 0 left, last index right. */
  data: number[];
  /** Width in px. Defaults to 56. */
  widthPx?: number;
  /** Height in px. Defaults to 16. */
  heightPx?: number;
  /** Tailwind color class for the bars. Defaults to 'fill-primary/60'. */
  barClassName?: string;
  /** Tailwind color class for zero-value bars. Defaults to barClassName. */
  zeroBarClassName?: string;
  /** Minimum height for non-zero bars. Defaults to 0 to preserve raw proportional rendering. */
  minValueHeightPx?: number;
  /** Height for zero-value bars. Defaults to 0. */
  zeroValueHeightPx?: number;
  /** Optional accessible label. Defaults to "Activity sparkline". */
  ariaLabel?: string;
  /** Native tooltip/title for dense list contexts. */
  title?: string;
  className?: string;
}

export function Sparkline({
  data,
  widthPx = 56,
  heightPx = 16,
  barClassName = 'fill-primary/60',
  zeroBarClassName,
  minValueHeightPx = 0,
  zeroValueHeightPx = 0,
  ariaLabel = 'Activity sparkline',
  title,
  className,
}: SparklineProps) {
  const n = data.length;
  if (n === 0) {
    return (
      <svg
        role="img"
        aria-label={ariaLabel}
        width={widthPx}
        height={heightPx}
        className={cn('inline-block', className)}
      >
        <title>{title ?? ariaLabel}</title>
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const gap = 1;
  const barWidth = Math.max(1, (widthPx - gap * (n - 1)) / n);
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width={widthPx}
      height={heightPx}
      className={cn('inline-block', className)}
    >
      <title>{title ?? ariaLabel}</title>
      {data.map((v, i) => {
        const scaledHeight = max === 0 ? 0 : Math.round((v / max) * heightPx);
        const h = Math.min(
          heightPx,
          v > 0
            ? Math.max(minValueHeightPx, scaledHeight)
            : zeroValueHeightPx,
        );
        const x = i * (barWidth + gap);
        const y = heightPx - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            className={v > 0 ? barClassName : zeroBarClassName ?? barClassName}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

const ACTIVITY_BUCKET_COUNT = 8;
function normalizeActivityBuckets(data: number[] | null | undefined): number[] {
  const source = data ?? [];
  if (source.length >= ACTIVITY_BUCKET_COUNT) {
    return source.slice(source.length - ACTIVITY_BUCKET_COUNT);
  }
  return [
    ...source,
    ...new Array(ACTIVITY_BUCKET_COUNT - source.length).fill(0),
  ];
}

function activityUnit(kind: ActivitySparklineProps['kind'], count: number): string {
  if (kind === 'session') return count === 1 ? 'prompt' : 'prompts';
  return count === 1 ? 'agent turn' : 'agent turns';
}

function activityScope(kind: ActivitySparklineProps['kind']): string {
  return kind === 'session' ? 'this session' : 'this run';
}

export interface ActivitySparklineProps
  extends Omit<
    SparklineProps,
    'data' | 'ariaLabel' | 'barClassName' | 'zeroBarClassName' | 'minValueHeightPx' | 'zeroValueHeightPx'
  > {
  data?: number[] | null;
  /** Sessions count prompt batches; agent runs count agent turns. */
  kind: 'session' | 'agent-run';
}

export function ActivitySparkline({
  data,
  kind,
  widthPx = 48,
  heightPx = 14,
  className,
  title,
  ...props
}: ActivitySparklineProps) {
  const buckets = normalizeActivityBuckets(data);
  const total = buckets.reduce((sum, value) => sum + value, 0);
  const label = `${total.toLocaleString()} ${activityUnit(kind, total)} across ${activityScope(kind)}`;
  const max = Math.max(...buckets, 1);
  const gap = 2;
  const barWidth = Math.max(2, (widthPx - gap * (buckets.length - 1)) / buckets.length);
  const color = kind === 'session' ? 'var(--sage)' : 'var(--primary)';

  return (
    <svg
      role="img"
      aria-label={label}
      width={widthPx}
      height={heightPx}
      viewBox={`0 0 ${widthPx} ${heightPx}`}
      className={cn('inline-block', className)}
      {...props}
    >
      <title>{title ?? label}</title>
      {buckets.map((value, index) => {
        const scaled = Math.round((value / max) * heightPx);
        const h = value > 0 ? Math.max(3, scaled) : 1;
        const x = index * (barWidth + gap);
        const y = heightPx - h;
        return (
          <rect
            key={index}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            rx={1}
            fill={color}
            opacity={value > 0 ? 0.75 : 0.18}
          />
        );
      })}
    </svg>
  );
}
