import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

/**
 * A measured value and the rows behind it.
 *
 * The two always travel together. A surface that could render the value alone
 * would let a figure from two prompts look like a figure from two thousand, so the
 * page has no shape to put a value in without its sample.
 */
export interface Measure {
  value: number | null;
  sampleSize: number;
}

export interface HarnessMeasure extends Measure {
  harness: string;
}

export interface KpiReport {
  windowDays: number | null;
  since: number | null;
  contextPresent: Measure;
  sporeServeRate: Measure;
  callsPerPrompt: Measure;
  callsPerPromptByHarness: HarnessMeasure[];
  planReadsPerSession: Measure;
  firstInjectionMs: Measure;
  evalPassRate: Measure;
}

/** The windows the page offers, and the label each carries. */
export const MEASURE_WINDOWS = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
] as const;

export type MeasureWindow = (typeof MEASURE_WINDOWS)[number]['id'];

export const DEFAULT_MEASURE_WINDOW: MeasureWindow = '30';

export function useKpis(window: MeasureWindow) {
  return useQuery({
    queryKey: ['kpis', window],
    queryFn: ({ signal }) => fetchJson<KpiReport>(`/api/kpis?window=${encodeURIComponent(window)}`, signal),
  });
}
