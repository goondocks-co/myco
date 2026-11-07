import type { RelationalStore } from '../../core/adapters.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { recallQuality, caseCount } from '../../evals/recall-baseline.js';
import { read, readSet } from '../index.js';
import { projectionPhases, kpiReadiness } from '../projections/catchup.js';
import { NEXT as KPI_METRIC_VERSION } from '../schema-vNEXT.js';
import { KPI_DAY_MS, KPI_MEASURES, type KpiMeasure } from './kpi-reconcile.js';

export { KPI_METRIC_VERSION };
export const KPI_WINDOWS = [7, 30, 90] as const;
export type KpiWindow = typeof KPI_WINDOWS[number] | null;
const MIN_DAY = Number.MIN_SAFE_INTEGER;
const MIN_MS = Number.MIN_SAFE_INTEGER;

export interface KpiMetadata {
  windowDays: number | null;
  since: number | null;
  windowStart: number | null;
  windowEnd: number;
  asOf: number;
  metricVersion: number;
}
export type KpiAnswer = KpiReport | (KpiMetadata & {
  state: 'building';
  progress: { completed: number; total: number };
});

export interface Measure {
  value: number | null;
  sampleSize: number;
}

export interface HarnessMeasure extends Measure {
  harness: string;
  calls: number;
}

export interface KpiReport extends KpiMetadata {
  state: 'ready';
  promptsServed: number;
  deliveries: { placed: number; unplaced: number };
  servedShare: Measure;
  sporeServeRate: Measure;
  sessionStartPresent: Measure;
  callsPerPrompt: Measure;
  callsPerPromptByHarness: HarnessMeasure[];
  planReadsPerSession: Measure;
  firstInjectionMs: Measure;
  recallQuality: Measure;
  promptIdentity: PromptIdentityCounts[];
}

export interface PromptIdentityCounts {
  harness: string;
  sampleSize: number;
  unrecognized: number;
  unmarked: number;
  openerConflict: number;
  contractViolation: number;
  reused: number;
  identityConflicts: number;
  schemeConflicts: number;
  mixedSchemeSessions: number;
  duplicatePromptSkips: number;
}

export function kpiWindow(raw: string | null): KpiWindow | undefined {
  if (raw === null || raw === 'all') return null;
  return KPI_WINDOWS.find(days => String(days) === raw);
}

export function utcWindow(window: KpiWindow, now: number) {
  const today = Math.floor(now / KPI_DAY_MS);
  const sinceDay = window === null ? null : today - window;
  return {
    days: window, today, sinceDay,
    windowStart: sinceDay === null ? null : sinceDay * KPI_DAY_MS,
    windowEnd: (today + 1) * KPI_DAY_MS - 1,
  };
}

const share = (numerator: number, sampleSize: number): Measure =>
  ({ value: sampleSize === 0 ? null : numerator / sampleSize, sampleSize });

export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

type Daily = Record<KpiMeasure, number> & { harness: string };
type KpiMeasures = Omit<KpiReport, keyof KpiMetadata | 'state'>;
const declaredAgents = new Set<string>(CAPTURE_RULE_BUNDLES.map(bundle => bundle.name));

const daily = read<[number, number], Daily>({
  name: 'kpi.daily',
  sql: `SELECT harness,${KPI_MEASURES.map(column => `SUM(${column}) AS ${column}`).join(',')}
    FROM kpi_daily WHERE day BETWEEN ? AND ? GROUP BY harness`,
});
const lineageSamples = read<[number, number], { ms: number }>({
  name: 'kpi.lineageSamples',
  sql: `SELECT first_served_at-started_at AS ms FROM kpi_lineage INDEXED BY idx_kpi_lineage_started
    WHERE started_at BETWEEN ? AND ? AND first_served_at>=started_at ORDER BY 1`,
});

export function formatKpis(rows: readonly Daily[], samples: readonly number[]): KpiMeasures {
  const total = (column: KpiMeasure) => rows.reduce((sum, row) => sum + row[column], 0);
  return {
    promptsServed: total('served'),
    deliveries: { placed: total('placed'), unplaced: total('deliveries') - total('placed') },
    servedShare: share(total('served'), total('prompts')),
    sporeServeRate: share(total('with_spores'), total('prompts')),
    sessionStartPresent: share(total('started_with_block'), total('sessions')),
    callsPerPrompt: share(total('calls'), total('prompts')),
    planReadsPerSession: share(total('plan_reads'), total('sessions')),
    callsPerPromptByHarness: rows.filter(row => row.prompts > 0 || row.calls > 0)
      .map(row => ({ harness: row.harness, calls: row.calls, ...share(row.calls, row.prompts) }))
      .sort((a, b) => b.sampleSize - a.sampleSize || b.calls - a.calls || a.harness.localeCompare(b.harness)),
    firstInjectionMs: { value: median(samples), sampleSize: samples.length },
    recallQuality: { value: recallQuality, sampleSize: caseCount },
    promptIdentity: rows.map(row => ({
      harness: row.harness, sampleSize: row.claimed, unrecognized: row.unrecognized, unmarked: row.unmarked,
      openerConflict: row.opener_conflict, contractViolation: row.contract_violation, reused: row.reused,
      identityConflicts: row.identity_conflicts, duplicatePromptSkips: row.duplicate_skips,
      schemeConflicts: declaredAgents.has(row.harness) ? row.scheme_conflicts : 0,
      mixedSchemeSessions: declaredAgents.has(row.harness) ? row.mixed_sessions : 0,
    })).filter(row => Object.entries(row).some(([key, value]) => key !== 'harness' && typeof value === 'number' && value > 0))
      .sort((a, b) => b.sampleSize - a.sampleSize || a.harness.localeCompare(b.harness)),
  };
}

export async function readKpis(db: RelationalStore, opts: { window: KpiWindow; now: number }): Promise<KpiAnswer> {
  const w = utcWindow(opts.window, opts.now);
  const [phases, rows, samples] = await readSet(db,
    projectionPhases.bind('kpi'),
    daily.bind(w.sinceDay ?? MIN_DAY, w.today),
    lineageSamples.bind(w.windowStart ?? MIN_MS, w.windowEnd));
  const base: KpiMetadata = {
    windowDays: w.days, since: w.windowStart, windowStart: w.windowStart,
    windowEnd: w.windowEnd, asOf: opts.now, metricVersion: KPI_METRIC_VERSION,
  };
  const { state, progress } = kpiReadiness(phases);
  return state === 'ready'
    ? { state: 'ready', ...base, ...formatKpis(rows, samples.map(sample => sample.ms)) }
    : { state: 'building', ...base, progress };
}
