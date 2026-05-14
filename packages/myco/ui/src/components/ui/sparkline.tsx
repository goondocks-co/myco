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
  /** Optional accessible label. Defaults to "Activity sparkline". */
  ariaLabel?: string;
  className?: string;
}

export function Sparkline({
  data,
  widthPx = 56,
  heightPx = 16,
  barClassName = 'fill-primary/60',
  ariaLabel = 'Activity sparkline',
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
      />
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
      {data.map((v, i) => {
        const h = max === 0 ? 0 : Math.round((v / max) * heightPx);
        const x = i * (barWidth + gap);
        const y = heightPx - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barWidth}
            height={h}
            className={barClassName}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}
