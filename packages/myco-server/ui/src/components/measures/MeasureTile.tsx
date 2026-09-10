import { AccentSurface } from '../ui/accent-surface';
import { Eyebrow } from '../ui/eyebrow';
import { cn } from '../../lib/cn';
import type { Measure } from '../../hooks/use-kpis';

/**
 * One measure, rendered with the sample behind it.
 *
 * This is the only shape on the page that renders a measured figure, and it
 * cannot render one without its sample: the sample line is emitted on every
 * path, and a measure with no rows behind it renders `noSample` in place of the
 * figure rather than a zero. A tile built any other way would be able to show a
 * number nobody can weigh, which is the failure the page exists to avoid.
 */
export interface MeasureTileProps {
  label: string;
  /** What the figure means, in one line. */
  note: string;
  measure: Measure;
  /** The figure, for a measure with rows behind it. */
  format: (value: number) => string;
  /** What the sample counts: `prompt`, `session`, `machine`. */
  unit: string;
  /** What to say when nothing has been measured yet. */
  noSample: string;
  tone?: 'sage' | 'ochre' | 'terra';
  /** True for the measure the page leads with. */
  primary?: boolean;
}

export function MeasureTile({ label, note, measure, format, unit, noSample, tone = 'sage', primary = false }: MeasureTileProps) {
  const measured = measure.sampleSize > 0 && measure.value !== null;
  const plural = measure.sampleSize === 1 ? unit : `${unit}s`;
  return (
    <AccentSurface accent={tone} padded className={cn('flex flex-col gap-2', primary && 'gap-3')} data-testid="measure-tile" aria-label={label}>
      <Eyebrow tone={tone} size="sm">{label}</Eyebrow>
      {measured ? (
        <div className={cn('tabular-nums text-on-surface', primary ? 'myco-display-lg' : 'myco-display-md')} data-testid="measure-value">
          {format(measure.value!)}
        </div>
      ) : (
        <p className="m-0 font-sans text-sm text-on-surface-variant" data-testid="measure-no-sample">{noSample}</p>
      )}
      <div className="font-mono text-[11px] tracking-wide text-outline" data-testid="measure-sample">
        n = {measure.sampleSize.toLocaleString()} {plural}
      </div>
      <p className="m-0 font-sans text-xs text-on-surface-variant">{note}</p>
    </AccentSurface>
  );
}
