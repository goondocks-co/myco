import { embeddingProviderReady } from './provider-state.js';
import { dueSourceWork } from '../../db/embeddings/work.js';
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
  /** The models whose provider may be asked now, when the caller read them once for many Projects. */
  ready?: readonly string[];
  /**
   * Probe even rows that rest clean, as an audit does: a stale idle answer is replaced, fenced by the revision probed.
   */
  fresh?: boolean;
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
  if (scope.ready !== undefined) writes.push(...candidates.filter(key => scope.ready!.includes(key)));
  else for (const key of candidates) if (await embeddingProviderReady(db,key,now)) writes.push(key);
  const retained = [...new Set([model, ...candidates, ...(scope.retain ?? [])])].sort();
  const pending = await recordedWork(db, projectId, model, 'embedding', JSON.stringify({ predicate: WORK_PREDICATE_VERSION, writes, retained }), now, async () => {
    if (await dueSourceWork(db, projectId, writes, now)) return { pending: true };
    if (await retiringReceipt(db, projectId, retained, now) !== null) return { pending: true };
    return { pending: false, wakeAt: await embeddingWakeAt(db, projectId, writes, now) };
  }, { fresh: scope.fresh === true });
  if (pending) return true;
  if (scope.retireOnly === true) return false;
  const calibrate = calibrationModel(model, scope.switching ?? null);
  return calibrationPending(db, projectId, calibrate, now, scope.fresh === true, retained);
}
