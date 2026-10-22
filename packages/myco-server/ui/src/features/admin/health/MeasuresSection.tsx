import { type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, ErrorState, LoadingState, Select, Stat } from '../../../design';
import { DEFAULT_MEASURE_WINDOW, isMeasureWindow, MEASURE_WINDOWS, useKpis, type MeasureWindow } from '../../../hooks/use-kpis';
import { formatElapsed } from '../../../lib/format';
import { harnessLabel } from '../../../lib/harness';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import type { KpiReport, Measure, PromptIdentityCounts } from './wire';
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
  // With nothing measured the figure's slot holds a dash, never a zero, and the sentence under it says why.
  const value: ReactNode = measured
    ? <span data-testid="measure-value">{format(measure.value!)}</span>
    : <span className="text-faint"><span aria-hidden>—</span><span className="sr-only">Not measured yet</span></span>;
  return (
    <div role="group" aria-label={label} data-testid="measure-tile" className="flex min-w-0">
      <Stat
        className="w-full"
        label={label}
        value={value}
        context={(
          <span className="flex flex-col gap-s1">
            <span className="t-meta text-faint" data-testid="measure-sample">{sampleWords(measure.sampleSize, unit)}</span>
            {!measured && <span className="text-ink-2" data-testid="measure-no-sample">{noSample}</span>}
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
      <div className="grid gap-s3 sm:grid-cols-2">
        <Stat label="Prompts served" value={report.promptsServed.toLocaleString()}
          context="Prompts in this window with spores or a plan reminder shown on their turn." />
        <Stat label="Deliveries" value={(report.deliveries.placed + report.deliveries.unplaced).toLocaleString()}
          context={`${report.deliveries.placed.toLocaleString()} shown on a turn · ${report.deliveries.unplaced.toLocaleString()} not on a turn. Context deliveries in this window.`} />
      </div>
      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-3">
        <MeasureStat
          label="Served share"
          note="The share of prompts in this window with context shown on their turn."
          measure={report.servedShare}
          format={percent}
          unit="prompt"
          noSample="No prompts have reached this server yet."
        />
        <MeasureStat
          label="Prompts that received a spore"
          note="The share of prompts that reached the agent carrying at least one spore."
          measure={report.sporeServeRate}
          format={percent}
          unit="prompt"
          noSample="No prompts have reached this server yet."
        />
        <MeasureStat
          label="Sessions that started with project context"
          note="The share of sessions this server sent its session start block."
          measure={report.sessionStartPresent}
          format={percent}
          unit="session"
          noSample="No sessions have been captured yet."
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
      <PromptIdentityCard rows={report.promptIdentity} />
    </div>
  );
}

/** What each count on the identity card is, in the words the card says it in. */
const IDENTITY_COUNTS: ReadonlyArray<readonly [keyof Omit<PromptIdentityCounts, 'harness' | 'sampleSize'>, string, string]> = [
  ['unrecognized', 'line', 'of a shape Myco does not know'],
  ['unmarked', 'prompt', 'with no record of who opened it'],
  ['openerConflict', 'prompt', 'whose record names two openers'],
  ['contractViolation', 'line', 'that contradicts its transcript'],
  ['reused', 'prompt', 'reusing an earlier prompt\u2019s id'],
  ['identityConflicts', 'line', 'refused a second name'],
  ['schemeConflicts', 'transcript', 'not read: its session needs two schemes'],
  ['mixedSchemeSessions', 'session', 'holding transcripts read two ways'],
  ['duplicatePromptSkips', 'context answer', 'not recorded against a prompt already named'],
];

/**
 * How the agents' transcripts named their prompts: counts of what a parse kept without naming it the usual way. A
 * nonzero count says a format moved or a rare case happened; the card names no session or line.
 */
function PromptIdentityCard({ rows }: { rows: readonly PromptIdentityCounts[] }) {
  return (
    <Card className="flex flex-col gap-s3" data-health-identity="">
      <h3 className="t-h3 text-ink">Transcript lines Myco could not name the usual way</h3>
      {rows.length === 0 ? (
        <p className="t-small text-muted">No transcript in this window was parsed under a scheme that records how each prompt is named.</p>
      ) : (
        <ul aria-label="Prompt naming counts by agent" className="flex flex-col divide-y divide-line">
          {rows.map((row) => {
            const nonzero = IDENTITY_COUNTS.filter(([field]) => row[field] > 0);
            return (
              <li key={row.harness} className="flex flex-col gap-s1 py-s2" data-identity-agent="">
                <span className="flex flex-wrap items-baseline justify-between gap-x-s4">
                  <span className="t-body font-medium text-ink" data-cell="agent">{harnessLabel(row.harness)}</span>
                  <span className="t-meta text-faint" data-cell="sample">n = {countOf(row.sampleSize, 'prompt')}</span>
                </span>
                {nonzero.length === 0 ? <span className="t-small text-muted" data-cell="none">Every line was named the usual way.</span> : (
                  <span className="flex flex-wrap gap-x-s4 gap-y-s1 t-small text-muted">
                    {nonzero.map(([field, unit, words]) => (
                      <span key={field} data-cell={field}><span className="tabular-nums text-ink-2">{countOf(row[field], unit)}</span> {words}</span>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
