/**
 * Bucket rail rows into time-window sections (ACTIVE / TODAY / YESTERDAY /
 * EARLIER) for the v6 mock's section-header rendering. Pure helper, shared
 * by the Sessions and Runs rails.
 */

export type SectionLabel = 'ACTIVE' | 'TODAY' | 'YESTERDAY' | 'EARLIER';

export interface SectionedRows<T> {
  label: SectionLabel;
  rows: T[];
}

export interface SectionRowsOptions<T> {
  /** Returns true when the row counts as active (status === 'active' / 'running'). */
  isActive: (row: T) => boolean;
  /**
   * Epoch seconds when the row was started; used for date-bucketing non-active
   * rows. Return null/undefined to bucket the row as EARLIER.
   */
  startedAtEpochSec: (row: T) => number | null | undefined;
  /** Override "now" (epoch seconds) for testability. Defaults to Date.now() / 1000. */
  nowEpochSec?: number;
}

const SECTION_ORDER: readonly SectionLabel[] = ['ACTIVE', 'TODAY', 'YESTERDAY', 'EARLIER'];

/**
 * Bucket rows into time-window sections, preserving each section's internal
 * order. Returned sections are always in display order; sections with zero
 * rows are omitted.
 */
export function sectionRows<T>(
  rows: readonly T[],
  options: SectionRowsOptions<T>,
): Array<SectionedRows<T>> {
  const { isActive, startedAtEpochSec, nowEpochSec } = options;

  const nowSec = nowEpochSec ?? Math.floor(Date.now() / 1000);
  const nowDate = new Date(nowSec * 1000);
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime() / 1000;
  const startOfYesterday = startOfToday - 24 * 60 * 60;

  const buckets: Record<SectionLabel, T[]> = {
    ACTIVE: [],
    TODAY: [],
    YESTERDAY: [],
    EARLIER: [],
  };

  for (const row of rows) {
    if (isActive(row)) {
      buckets.ACTIVE.push(row);
      continue;
    }
    const started = startedAtEpochSec(row);
    if (started === null || started === undefined) {
      buckets.EARLIER.push(row);
      continue;
    }
    if (started >= startOfToday) {
      buckets.TODAY.push(row);
    } else if (started >= startOfYesterday) {
      buckets.YESTERDAY.push(row);
    } else {
      buckets.EARLIER.push(row);
    }
  }

  const sections: Array<SectionedRows<T>> = [];
  for (const label of SECTION_ORDER) {
    if (buckets[label].length > 0) {
      sections.push({ label, rows: buckets[label] });
    }
  }
  return sections;
}
