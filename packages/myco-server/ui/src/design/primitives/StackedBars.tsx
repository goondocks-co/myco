import { useId } from 'react';
import { cn } from '../../lib/cn';

/** One slot's parts, bottom first: each a count and the tone it is drawn in. */
export interface StackedSlot { parts: ReadonlyArray<{ value: number; tone: 'ok' | 'bad' | 'faint' }> }

export interface StackedBarsProps {
  /** Slots in order, oldest first; a slot whose parts sum to zero is drawn hatched. */
  slots: readonly StackedSlot[];
  /** What the bars show, in words, for assistive technology. */
  label: string;
  height?: number;
  className?: string;
}

const TONE_FILL = { ok: 'fill-ok', bad: 'fill-bad', faint: 'fill-line-strong' } as const;

/** A full-width row of stacked bars, one per slot, scaled to the fullest slot; an empty slot is hatched so a gap reads as a gap. */
export function StackedBars({ slots, label, height = 28, className }: StackedBarsProps) {
  const hatch = useId();
  const width = 100;
  const gap = slots.length > 1 ? 0.4 : 0;
  const bar = slots.length === 0 ? 0 : (width - gap * (slots.length - 1)) / slots.length;
  const most = Math.max(1, ...slots.map((slot) => slot.parts.reduce((sum, part) => sum + part.value, 0)));
  return (
    <svg role="img" aria-label={label} width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn('block', className)}>
      <title>{label}</title>
      <defs>
        <pattern id={hatch} width={1.2} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width={0.4} height={4} className="fill-line" />
        </pattern>
      </defs>
      {slots.map((slot, index) => {
        const x = index * (bar + gap);
        const total = slot.parts.reduce((sum, part) => sum + part.value, 0);
        if (total === 0) return <rect key={index} x={x} y={0} width={bar} height={height} fill={`url(#${hatch})`} />;
        let top = height;
        return slot.parts.filter((part) => part.value > 0).map((part, i) => {
          const h = Math.max(height * 0.12, (part.value / most) * height);
          top -= h;
          return <rect key={`${index}-${i}`} x={x} y={Math.max(0, top)} width={bar} height={h} className={TONE_FILL[part.tone]} />;
        });
      })}
    </svg>
  );
}
