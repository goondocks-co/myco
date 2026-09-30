import { type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, ErrorState, LoadingState, Select, Stat } from '../../../design';
import { DEFAULT_MEASURE_WINDOW, isMeasureWindow, MEASURE_WINDOWS, useKpis, type MeasureWindow } from '../../../hooks/use-kpis';
import { formatElapsed } from '../../../lib/format';
import { harnessLabel } from '../../../lib/harness';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import type { KpiReport, Measure } from './wire';
import { countOf, percent, perUnit, sampleWords } from './words';

interface MeasureProps {
  label: string;
  /** What the figure means, in one line. */
  note: string;
  measure: Measure;
  format: (value: number) => string;
  /** What the sample counts: `prompt`, `session`, `machine`. */
  unit: string;
  /** What to say when nothing has been measured yet. */
  noSample: string;
}

/**
 * One measure, with the sample behind it. The sample line is said on every
 * path, and a measure with no rows behind it says so in place of the figure,
 * never as a zero: a figure nobody can weigh is the failure these exist to avoid.
 */
function MeasureStat({ label, note, measure, format, unit, noSample }: MeasureProps) {
  const measured = measure.sampleSize > 0 && measure.value !== null;
  const value: ReactNode = measured
    ? <span data-testid="measure-value">{format(measure.value!)}</span>
    : <span className="t-body not-italic text-muted" data-testid="measure-no-sample">{noSample}</span>;
  return (
    <div role="group" aria-label={label} data-testid="measure-tile" className="flex min-w-0">
      <Stat
        className="w-full"
        label={label}
        value={value}
        context={(
          <span className="flex flex-col gap-s1">
            <span className="t-meta text-faint" data-testid="measure-sample">{sampleWords(measure.sampleSize, unit)}</span>
            <span>{note}</span>
          </span>
        )}
      />
    </div>
  );
}

/**
 * Measures: whether Myco is reaching the work, counted by the server from what
 * it holds. The window sits in the URL, so a link carries what it was read over.
 */
export function MeasuresSection() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('window');
  const chosen: MeasureWindow = isMeasureWindow(requested) ? requested : DEFAULT_MEASURE_WINDOW;
  const kpis = useKpis(chosen);
  const choose = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id === DEFAULT_MEASURE_WINDOW) next.delete('window'); else next.set('window', id);
    return next;
  }, { replace: true, preventScrollReset: true });

  return (
    <AdminSection
      id={HEALTH_ANCHORS.measures}
      title="Measures"
      description="Whether Myco is reaching the work, counted from what this server holds. Every figure names the sample behind it; nothing here is estimated."
      actions={(
        <Select
          label="Window"
          className="w-select-wide"
          value={chosen}
          onValueChange={choose}
          options={MEASURE_WINDOWS.map((w) => ({ value: w.id, label: w.label }))}
        />
      )}
    >
      {kpis.isPending ? <LoadingState shape="cards" count={3} label="Reading the measures" />
        : kpis.data === undefined ? <ErrorState error={kpis.error} onRetry={() => void kpis.refetch()} />
        : <Measures report={kpis.data} />}
    </AdminSection>
  );
}

function Measures({ report }: { report: KpiReport }) {
  return (
    <div className="flex flex-col gap-s4">
      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-3">
        <MeasureStat
          label="Prompts that arrived with context"
          note="The share of prompts this server had already answered with something: a spore, a plan nudge, or the session’s instructions."
          measure={report.contextPresent}
          format={percent}
          unit="prompt"
          noSample="No prompts have reached this server yet."
        />
        <MeasureStat
          label="Prompts served a spore"
          note="The share of prompts that carried at least one spore."
          measure={report.sporeServeRate}
          format={percent}
          unit="prompt"
          noSample="No prompts have reached this server yet."
        />
        <MeasureStat
          label="Myco calls per prompt"
          note="How often an agent reaches back for memory. Higher is not better, it is louder."
          measure={report.callsPerPrompt}
          format={perUnit}
          unit="prompt"
          noSample="No prompts have reached this server yet."
        />
        <MeasureStat
          label="Plan reads per session"
          note="How often a session reads a plan it or another session wrote."
          measure={report.planReadsPerSession}
          format={perUnit}
          unit="session"
          noSample="No sessions have been captured yet."
        />
        <MeasureStat
          label="Time to first context"
          note="The middle wait, per machine, from joining to the first time this server served one of its sessions something."
          measure={report.firstInjectionMs}
          format={formatElapsed}
          unit="machine"
          noSample="No machine has been served context yet."
        />
        <MeasureStat
          label="Recall quality"
          note="How closely what this release hands a prompt matches what should come back, over a fixed set of real prompts from past sessions. Scored before release; this server’s own traffic does not change it."
          measure={report.recallQuality}
          format={percent}
          unit="prompt"
          noSample="No recall score was recorded for this release."
        />
      </div>
      <Card className="flex flex-col gap-s3" data-health-split="">
        <h3 className="t-h3 text-ink">Myco calls per prompt, by agent</h3>
        {report.callsPerPromptByHarness.length === 0 ? (
          <p className="t-small text-muted">No prompts in this window, so there is nothing to split by agent.</p>
        ) : (
          <>
            <ul aria-label="Calls per prompt by agent" className="flex flex-col divide-y divide-line">
              {report.callsPerPromptByHarness.map((row) => (
                <li key={row.harness} className="flex flex-wrap items-baseline justify-between gap-x-s4 gap-y-s1 py-s2" data-agent-split="">
                  <span className="t-body font-medium text-ink" data-cell="agent">{harnessLabel(row.harness)}</span>
                  <span className="flex flex-wrap items-baseline gap-x-s4 t-small text-muted">
                    <span><span className="tabular-nums text-ink-2" data-cell="calls">{row.calls.toLocaleString()}</span> {row.calls === 1 ? 'call' : 'calls'}</span>
                    <span><span className="tabular-nums text-ink-2" data-cell="rate">{row.value === null ? '—' : perUnit(row.value)}</span> per prompt</span>
                    <span className="t-meta text-faint" data-cell="sample">n = {countOf(row.sampleSize, 'prompt')}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="t-small text-muted">The calls add up to the whole above. A rate reads as a dash where the agent made calls in this window but none of its prompts landed in it.</p>
          </>
        )}
      </Card>
    </div>
  );
}
