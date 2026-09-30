import { cn } from '../../lib/cn';

export interface SparklineProps {
  /** Values in order, oldest first. */
  data: readonly number[];
  /** What the line shows, in words, for assistive technology. */
  label: string;
  width?: number;
  height?: number;
  className?: string;
}

/** A bar sparkline for Health measures: bars scale to the largest value, empty buckets show a hairline. */
export function Sparkline({ data, label, width = 80, height = 20, className }: SparklineProps) {
  const max = Math.max(...data, 1);
  const gap = 2;
  const bar = data.length === 0 ? 0 : Math.max(2, (width - gap * (data.length - 1)) / data.length);
  return (
    <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('inline-block shrink-0', className)}>
      <title>{label}</title>
      {data.map((value, index) => {
        const h = value > 0 ? Math.max(2, Math.round((value / max) * height)) : 1;
        return (
          <rect
            key={index}
            x={index * (bar + gap)}
            y={height - h}
            width={bar}
            height={h}
            rx={1}
            className={value > 0 ? 'fill-primary' : 'fill-line-strong'}
          />
        );
      })}
    </svg>
  );
}
