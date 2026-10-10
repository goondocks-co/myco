import type { RelationalStore } from '../adapters.js';
import { calibrationPending } from './hubness.js';
import { calibrationModel } from './policy.js';
import { embeddingWakeAt, retiringReceipt, unwrittenQuery } from './selection.js';
import { recordedWork, WORK_PREDICATE_VERSION } from './work-state.js';
import { embeddingSweep } from './work-sweep.js';

/** What a Project's embedding work covers while a switch stands, and whether the Project is archived. */
export interface EmbeddingWorkScope {
  /** A switch's model while it is asked: sources it has not written, or skipped, are work. */
  building?: string | null;
  /** Every further model whose vectors are kept. */
  retain?: readonly string[];
  /** A standing switch's model, which calibration covers instead of `model`. */
  switching?: string | null;
  /** An archived Project's only work is retiring vectors. */
  retireOnly?: boolean;
}

/**
 * The backlog includes sources awaiting a write, passed-over sources aside, under `model` or under a switch's `building` model, deletions that are
 * due and pending spore calibration, under a standing switch's model while it stands. An archived Project's backlog is
 * its due deletions alone.
 */
export async function hasEmbeddingWork(db: RelationalStore, projectId: string, model: string, now: number, scope: EmbeddingWorkScope = {}): Promise<boolean> {
  const writes = scope.retireOnly === true ? [] : [model, ...(scope.building == null ? [] : [scope.building])];
  const retained = [...new Set([model, ...writes, ...(scope.retain ?? [])])].sort();
  const pending = await recordedWork(db, projectId, model, 'embedding', JSON.stringify({ predicate: WORK_PREDICATE_VERSION, writes, retained }), now, async () => {
    for (const key of writes) {
      const { sql, binds } = unwrittenQuery(projectId, key, now);
      if (await db.prepare(sql).bind(...binds).first() !== null) return { pending: true };
    }
    if (await retiringReceipt(db, projectId, retained, now) !== null) return { pending: true };
    return { pending: false, wakeAt: await embeddingWakeAt(db, projectId, writes, now) };
  }, (cursor) => embeddingSweep(db, projectId, writes, retained, now, cursor));
  if (pending) return true;
  return scope.retireOnly !== true && calibrationPending(db, projectId, calibrationModel(model, scope.switching ?? null), now);
}

/** A partial safety cycle continues through the Deployment's chained wake job. */
export async function hasEmbeddingSweep(db: RelationalStore, projectId: string, model: string, scope: EmbeddingWorkScope = {}): Promise<boolean> {
  const identities = [[model, 'embedding'], ...(scope.retireOnly === true ? [] : [[calibrationModel(model, scope.switching ?? null), 'hubness']])];
  for (const [key, kind] of identities) {
    const row = await db.prepare(`SELECT sweep_cursor FROM embedding_work_state
      WHERE project_id=? AND model_key=? AND kind=?`).bind(projectId, key, kind).first<{ sweep_cursor: string | null }>();
    if (row?.sweep_cursor != null) return true;
  }
  return false;
}
