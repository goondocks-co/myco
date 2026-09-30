import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { KpiReport } from '../features/admin/health/wire';

export type { HarnessMeasure, KpiReport, Measure } from '../features/admin/health/wire';

/** The windows the measures offer, and the label each carries. */
export const MEASURE_WINDOWS = [
  { id: '7', label: 'Last 7 days' },
  { id: '30', label: 'Last 30 days' },
  { id: '90', label: 'Last 90 days' },
  { id: 'all', label: 'All time' },
] as const;

export type MeasureWindow = (typeof MEASURE_WINDOWS)[number]['id'];

export const DEFAULT_MEASURE_WINDOW: MeasureWindow = '30';

/** Whether a query value names a window the measures offer. */
export const isMeasureWindow = (value: string | null): value is MeasureWindow =>
  value !== null && MEASURE_WINDOWS.some((w) => w.id === value);

/** The measures over a window, counted by the server. */
export function useKpis(window: MeasureWindow) {
  return useQuery({
    queryKey: ['kpis', window],
    queryFn: ({ signal }) => fetchJson<KpiReport>(`/api/kpis?window=${encodeURIComponent(window)}`, signal),
  });
}
