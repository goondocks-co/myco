import type { RelationalStore } from '../adapters.js';
import { commit, readSet } from '../../db/index.js';
import { workChecked, workRow, workScope } from '../../db/embeddings/work.js';

export const WORK_SWEEP_PAGE = 256;
export const WORK_PREDICATE_VERSION = 4;
export const WORK_SWEEP_CONTINUE_MS = 30_000;
export const WORK_SWEEP_MIN_MS = 5 * 60_000;
export const WORK_SWEEP_MAX_MS = 30 * 60_000;

export interface WorkSweep {
  pending: boolean;
  /** Null completes this bounded sweep cycle. */
  cursor: string | null;
}

/**
 * Source and journal triggers dirty these rows in their own transaction. A check only acknowledges the revision it
 * read; a concurrent writer leaves work pending. Missing rows and a changed model scope require a fresh check.
 *
 * Without `sweep`, the check is the whole answer: a clean row with nothing pending stays idle until a mutation dirties
 * it or its wake time comes, and a pending row is checked again on every call, which reads only indexed heads. With
 * `sweep`, clean rows also receive bounded, cursor-driven safety sweeps with idle backoff.
 */
export async function recordedWork(
  db: RelationalStore, projectId: string, model: string, kind: 'embedding' | 'hubness', scope: string, now: number,
  probe: () => Promise<{ pending: boolean; wakeAt?: number | null }>,
  sweep?: (cursor: string | null) => Promise<WorkSweep>,
): Promise<boolean> {
  const identity = [projectId, model, kind] as const;
  let [row] = (await readSet(db, workRow.bind(...identity)))[0];
  if (row === undefined || row.scope !== scope) {
    const [, rows] = await commit(db, workScope.bind(...identity, scope), workRow.bind(...identity));
    row = rows.results[0];
    if (row === undefined || row.scope !== scope) return true;
  }
  const dirty = row.revision !== row.checked_revision;
  const due = row.wake_at !== null && row.wake_at <= now;
  if (sweep === undefined) {
    if (!dirty && !due && row.pending === 0) return false;
    const result = await probe();
    if (!dirty && !due && result.pending) return true;
    const wakeAt = 'wakeAt' in result ? result.wakeAt ?? null : null;
    const [checked] = await commit(db, workChecked.bind(result.pending ? 1 : 0, wakeAt, 0, null, 0, ...identity, scope, row.revision));
    return checked.results.length !== 1 || result.pending;
  }
  if (!dirty && !due && row.sweep_at > now) return row.pending === 1;

  const scanning = !dirty && !due;
  const result: { pending: boolean; wakeAt?: number | null; cursor?: string | null } = scanning ? await sweep(row.sweep_cursor) : await probe();
  const cursor = result.cursor ?? null;
  if (scanning && cursor !== null && row.pending === 1) result.pending = true;
  const rounds = result.pending || dirty ? 0 : cursor === null ? Math.min(row.idle_rounds + 1, 4) : row.idle_rounds;
  const interval = cursor === null ? Math.min(WORK_SWEEP_MAX_MS, WORK_SWEEP_MIN_MS * 2 ** rounds) : WORK_SWEEP_CONTINUE_MS;
  const wakeAt = 'wakeAt' in result ? result.wakeAt ?? null : row.wake_at !== null && row.wake_at > now ? row.wake_at : null;
  const [checked] = await commit(db, workChecked.bind(result.pending ? 1 : 0, wakeAt, now + interval, cursor, rounds, ...identity, scope, row.revision));
  return checked.results.length !== 1 || result.pending;
}
