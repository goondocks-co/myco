import type { JobBudget, RelationalStore } from './adapters.js';
import { commitRawBackfillPage, RAW_BACKFILL_SOURCES, rawBackfillPage as readBackfillPage, rawBackfillState } from '../db/raw/backfill.js';

export const RAW_BACKFILL_BATCH = 500;
export const RAW_BACKFILL_BUDGET: Readonly<JobBudget> = { calls: 120, wallMs: 2_000 };
/** Two reads and at most four statements in the atomic page commit. */
const PAGE_CALLS = 6;

/** One bounded source page and its checkpoint commit together; retries retain the first attribution. */
async function rawBackfillPage(db: RelationalStore, now: number): Promise<{ changed: number; more: boolean }> {
  const state = await rawBackfillState(db);
  if (state === null || state.complete === 1) return { changed: 0, more: false };
  const rows = await readBackfillPage(db, state, RAW_BACKFILL_BATCH);
  const last = rows.at(-1);
  const finishedSource = rows.length < RAW_BACKFILL_BATCH;
  const nextSource = finishedSource ? state.source + 1 : state.source;
  const changed = await commitRawBackfillPage(db, { held: state, selected: rows, now, next: {
    source: nextSource, cursorProject: finishedSource ? '' : last!.project_id, cursorId: finishedSource ? '' : last!.resource_id } });
  return { changed, more: nextSource < RAW_BACKFILL_SOURCES };
}

/** Drains independently committed pages within a statement and elapsed-time allowance. */
export async function rawBackfill(
  db: RelationalStore,
  now: number,
  { budget = RAW_BACKFILL_BUDGET, clock = Date.now }: { budget?: Readonly<JobBudget>; clock?: () => number } = {},
): Promise<{ changed: number; more: boolean }> {
  const deadline = clock() + budget.wallMs;
  let changed = 0;
  let more = true;
  let longestPageMs = 0;
  for (let calls = 0; more && calls + PAGE_CALLS <= budget.calls; calls += PAGE_CALLS) {
    const start = clock();
    if (start + longestPageMs >= deadline) break;
    const page = await rawBackfillPage(db, now);
    changed += page.changed;
    more = page.more;
    longestPageMs = Math.max(longestPageMs, clock() - start);
  }
  return { changed, more };
}
