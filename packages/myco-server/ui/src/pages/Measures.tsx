import { useSearchParams } from 'react-router-dom';
import { MeasureTile } from '../components/measures/MeasureTile';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { SubtabPill } from '../components/ui/subtab-pill';
import { DEFAULT_MEASURE_WINDOW, MEASURE_WINDOWS, useKpis, type MeasureWindow } from '../hooks/use-kpis';
import { formatElapsed } from '../lib/format';

const isWindow = (value: string | null): value is MeasureWindow =>
  value !== null && MEASURE_WINDOWS.some((w) => w.id === value);

const percent = (share: number): string => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
/** A count and what it counts, agreeing in number the way every sample line does. */
const countOf = (n: number, unit: string): string => `${n.toLocaleString()} ${n === 1 ? unit : `${unit}s`}`;
const perUnit = (n: number): string => n.toFixed(n >= 10 ? 0 : 2);

/** The harness name a person reads, from the name its transcript carries. */
const HARNESS_LABEL: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  windsurf: 'Windsurf',
  unrecorded: 'Agent not recorded',
};

/**
 * `/measures`: whether Myco is actually reaching the work, measured from what this
 * server holds.
 *
 * Every figure on this page carries the rows behind it. The window sits in the
 * URL, so a link carries what it was read over, and the server does the counting.
 */
export function Measures() {
  const [params, setParams] = useSearchParams();
  const chosen = isWindow(params.get('window')) ? params.get('window') as MeasureWindow : DEFAULT_MEASURE_WINDOW;
  const kpis = useKpis(chosen);
  const report = kpis.data;

  return (
    <PageContainer>
      <PageHeader
        title="Measures"
        subtitle="Whether Myco is reaching the work, counted from what this server holds. Every figure names the sample behind it; nothing here is estimated."
      />
      <div className="mb-2">
        <SubtabPill
          tabs={MEASURE_WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
          activeTab={chosen}
          onTabChange={(id) => setParams((prev) => {
            const next = new URLSearchParams(prev);
            if (id === DEFAULT_MEASURE_WINDOW) next.delete('window'); else next.set('window', id);
            return next;
          }, { replace: true })}
        />
      </div>
      <PageLoading isLoading={kpis.isPending} error={kpis.error}>
        {report && (
          <div className="flex flex-col gap-6">
            <MeasureTile
                primary
                label="Prompts that arrived with context"
                note="The share of prompts this server had already answered with something — an observation, a plan nudge, or the session's instructions."
                measure={report.contextPresent}
                format={percent}
                unit="prompt"
                noSample="No prompts have reached this server yet."
              />

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MeasureTile
                label="Prompts served an observation"
                note="The share of prompts that carried at least one spore."
                measure={report.sporeServeRate}
                format={percent}
                unit="prompt"
                noSample="No prompts have reached this server yet."
                tone="ochre"
              />
              <MeasureTile
                label="Myco calls per prompt"
                note="How often an agent reaches back for memory. A diagnostic: higher is not better, it is louder."
                measure={report.callsPerPrompt}
                format={perUnit}
                unit="prompt"
                noSample="No prompts have reached this server yet."
                tone="ochre"
              />
              <MeasureTile
                label="Plan reads per session"
                note="How often a session reads a plan it or another session wrote."
                measure={report.planReadsPerSession}
                format={perUnit}
                unit="session"
                noSample="No sessions have been captured yet."
              />
              <MeasureTile
                label="Time to first context"
                note="The middle wait, per machine, from joining to the first time this server served one of its sessions something."
                measure={report.firstInjectionMs}
                format={formatElapsed}
                unit="machine"
                noSample="No machine has been served context yet."
              />
              <MeasureTile
                label="Evaluation pass rate"
                note="The share of recorded checks that passed."
                measure={report.evalPassRate}
                format={percent}
                unit="check"
                noSample="No evaluations recorded. Nothing here runs checks yet, so there is no rate to show."
                tone="terra"
              />
            </div>

            <Panel eyebrow="Diagnostic" title="Myco calls per prompt, by agent" padded={report.callsPerPromptByHarness.length === 0} footer={report.callsPerPromptByHarness.length === 0 ? undefined : <p className="m-0 font-sans text-xs text-on-surface-variant">The calls column adds up to the whole above. A rate reads as an em dash where the agent made calls in this window but none of its prompts landed in it.</p>}>
              {report.callsPerPromptByHarness.length === 0 ? (
                <p className="m-0 font-sans text-sm text-on-surface-variant">No prompts in this window, so there is nothing to split by agent.</p>
              ) : (
                <table className="w-full font-sans text-sm">
                  <thead className="text-left font-mono text-[10px] uppercase tracking-wide text-outline">
                    <tr><th className="py-1">Agent</th><th className="py-1">Myco calls</th><th className="py-1">Calls per prompt</th><th className="py-1">Sample</th></tr>
                  </thead>
                  <tbody aria-label="Calls per prompt by agent">
                    {report.callsPerPromptByHarness.map((row) => (
                      <tr key={row.harness} className="border-t border-[var(--ghost-border)]">
                        <td className="py-1.5 text-on-surface">{HARNESS_LABEL[row.harness] ?? row.harness}</td>
                        <td className="py-1.5 tabular-nums text-on-surface">{row.calls.toLocaleString()}</td>
                        <td className="py-1.5 tabular-nums text-on-surface">{row.value === null ? '—' : perUnit(row.value)}</td>
                        <td className="py-1.5 font-mono text-[11px] text-on-surface-variant">n = {countOf(row.sampleSize, 'prompt')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        )}
      </PageLoading>
    </PageContainer>
  );
}
