/** Rail rows bucketed into time-window sections: what is still open, then today, yesterday and earlier. Pure; shared by the session rail and any rail that reads the same way. */

export type SectionLabel = 'OPEN' | 'TODAY' | 'YESTERDAY' | 'EARLIER';

export interface SectionedRows<T> {
  label: SectionLabel;
  rows: T[];
}

export interface SectionRowsOptions<T> {
  /** True when the row belongs at the top regardless of its date. */
  isOpen: (row: T) => boolean;
  /** When the row started, in epoch milliseconds; null buckets it as EARLIER. */
  startedAtMs: (row: T) => number | null;
  /** Override "now" (epoch milliseconds) for testability. */
  nowMs?: number;
}

const SECTION_ORDER: readonly SectionLabel[] = ['OPEN', 'TODAY', 'YESTERDAY', 'EARLIER'];

/** Buckets rows into sections in display order, keeping each section's own order, omitting empty sections, and answering the flattened order the sections render in — the order keyboard navigation and default selection follow. */
export function sectionRowsWithOrder<T>(rows: readonly T[], options: SectionRowsOptions<T>): { sections: SectionedRows<T>[]; orderedRows: T[] } {
  const now = new Date(options.nowMs ?? Date.now());
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const buckets: Record<SectionLabel, T[]> = { OPEN: [], TODAY: [], YESTERDAY: [], EARLIER: [] };
  for (const row of rows) {
    if (options.isOpen(row)) { buckets.OPEN.push(row); continue; }
    const started = options.startedAtMs(row);
    if (started === null) buckets.EARLIER.push(row);
    else if (started >= startOfToday) buckets.TODAY.push(row);
    else if (started >= startOfYesterday) buckets.YESTERDAY.push(row);
    else buckets.EARLIER.push(row);
  }
  const sections: SectionedRows<T>[] = [];
  const orderedRows: T[] = [];
  for (const label of SECTION_ORDER) {
    if (buckets[label].length === 0) continue;
    sections.push({ label, rows: buckets[label] });
    orderedRows.push(...buckets[label]);
  }
  return { sections, orderedRows };
}
