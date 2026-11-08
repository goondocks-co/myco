import type { RelationalStore } from '../adapters.js';
import { commit, readSet } from '../../db/index.js';
import { workChecked, workRow, workScope } from '../../db/embeddings/work.js';

export const WORK_PREDICATE_VERSION = 4;
/** How soon a wake chained to finish an audit of every Project follows. */
export const WORK_SWEEP_CONTINUE_MS = 30_000;

/**
 * Source and journal triggers dirty these rows in their own transaction. A check only acknowledges the revision it
 * read; a concurrent writer leaves work pending. Missing rows and a changed model scope require a fresh check.
 *
 * The check is the whole answer: a clean row with nothing pending stays idle until a mutation dirties it or its wake
 * time comes, and a pending row is checked again on every call, which reads only indexed heads. With `fresh`, a clean
 * row is probed too, and a different answer is recorded against the revision the probe read; an unchanged answer writes
 * nothing. No row is ever swept: work is found through what mutations maintain, and an audit's fresh probes.
 */
export async function recordedWork(
  db: RelationalStore, projectId: string, model: string, kind: 'embedding' | 'hubness', scope: string, now: number,
  probe: () => Promise<{ pending: boolean; wakeAt?: number | null }>, options: { fresh?: boolean } = {},
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
  const resting = !dirty && !due && row.pending === 0;
  if (resting && options.fresh !== true) return false;
  const result = await probe();
  if (!dirty && !due && result.pending && row.pending === 1) return true;
  const wakeAt = 'wakeAt' in result ? result.wakeAt ?? null : null;
  if (resting && !result.pending && wakeAt === row.wake_at) return false;
  const [checked] = await commit(db, workChecked.bind(result.pending ? 1 : 0, wakeAt, 0, null, 0, ...identity, scope, row.revision));
  return checked.results.length !== 1 || result.pending;
}
