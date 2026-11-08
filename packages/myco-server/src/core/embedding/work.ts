import { embeddingProviderReady } from './provider-state.js';
import { dueSourceWork, workRow } from '../../db/embeddings/work.js';
import { readSet } from '../../db/index.js';
import type { RelationalStore } from '../adapters.js';
import { calibrationPending } from './hubness.js';
import { calibrationModel } from './policy.js';
import { embeddingWakeAt, retiringReceipt } from './selection.js';
import { recordedWork, WORK_PREDICATE_VERSION } from './work-state.js';

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
 * Work is found through maintained due rows and retirement heads only; no source or receipt is walked to find it.
 * The backlog includes sources awaiting a write, passed-over sources aside, under `model` or under a switch's `building` model, deletions that are
 * due and pending spore calibration, under a standing switch's model while it stands. An archived Project's backlog is
 * its due deletions alone.
 */
export async function hasEmbeddingWork(db: RelationalStore, projectId: string, model: string, now: number, scope: EmbeddingWorkScope = {}): Promise<boolean> {
  const candidates = scope.retireOnly === true ? [] : [model, ...(scope.building == null ? [] : [scope.building])];
  const writes: string[] = [];
  for (const key of candidates) if (await embeddingProviderReady(db,key,now)) writes.push(key);
  const retained = [...new Set([model, ...candidates, ...(scope.retain ?? [])])].sort();
  const pending = await recordedWork(db, projectId, model, 'embedding', JSON.stringify({ predicate: WORK_PREDICATE_VERSION, writes, retained }), now, async () => {
    if (await dueSourceWork(db, projectId, writes, now)) return { pending: true };
    if (await retiringReceipt(db, projectId, retained, now) !== null) return { pending: true };
    return { pending: false, wakeAt: await embeddingWakeAt(db, projectId, writes, now) };
  });
  if (pending) return true;
  return scope.retireOnly !== true && calibrationPending(db, projectId, calibrationModel(model, scope.switching ?? null), now);
}

/** A partial calibration safety cycle continues through the Deployment's chained wake job; embedding work has none. */
export async function hasEmbeddingSweep(db: RelationalStore, projectId: string, model: string, scope: EmbeddingWorkScope = {}): Promise<boolean> {
  if (scope.retireOnly === true) return false;
  const [rows] = await readSet(db, workRow.bind(projectId, calibrationModel(model, scope.switching ?? null), 'hubness'));
  return rows[0]?.sweep_cursor != null;
}
