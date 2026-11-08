/**
 * The Deployment's embedding model switch, as stored: at most one row, read, started, paused, resumed and ended only
 * through this module.
 */
import type { RelationalStore } from '../adapters.js';
import { isEmbeddingProvider, type EmbeddingProviderId } from '@goondocks/myco-shared/settings-contract';
import {
  deleteStoredSwitch, holdStoredSwitch, insertStoredSwitch, pauseStoredSwitch, progressStoredSwitch, resumeStoredSwitch, storedProjectArchived, storedSwitch,
  waitStoredSwitch,
} from '../../db/embeddings/switch.js';
export { SWITCH_STANDS_SQL } from '../../db/embeddings/switch.js';


export type SwitchState = 'building' | 'paused';

export interface EmbeddingSwitch {
  id: string;
  provider: EmbeddingProviderId;
  model: string;
  endpoint: string | null;
  /** The identity the new vectors are partitioned under. */
  modelKey: string;
  /** The identity search uses while the new vectors are built, or null when none is in use. */
  fromModelKey: string | null;
  estimatedTokens: number;
  /** The count of sources `estimatedTokens` covers. */
  estimatedSources: number;
  state: SwitchState;
  reason: string | null;
  /** While building, the instant the new model is asked again after it failed, or null. */
  retryAt: number | null;
  /** The new model's failures in a row, counted from its last written vector. */
  failures: number;
  /** The instant the new model last wrote a vector, or the switch started. */
  progressedAt: number;
  startedAt: number;
  startedBy: string;
}

/** The stored `from_model_key` of a switch begun with no model in use. */
const NONE = '';

/** The switch under way, or null. A row naming a provider this release does not know reads as paused, saying so. */
export async function readSwitch(db: RelationalStore): Promise<EmbeddingSwitch | null> {
  const row = await storedSwitch(db);
  if (row === null) return null;
  const known = isEmbeddingProvider(row.provider);
  return {
    id: row.id,
    provider: known ? row.provider as EmbeddingProviderId : 'openai-compatible',
    model: row.model,
    endpoint: row.endpoint,
    modelKey: row.model_key,
    fromModelKey: row.from_model_key === NONE ? null : row.from_model_key,
    estimatedTokens: row.estimated_tokens,
    estimatedSources: row.estimated_sources,
    state: known && row.state === 'building' ? 'building' : 'paused',
    reason: known ? row.reason : `This server does not offer ${row.provider}. Cancel the switch.`,
    retryAt: row.retry_at,
    failures: row.failures,
    progressedAt: row.progressed_at,
    startedAt: row.started_at,
    startedBy: row.started_by,
  };
}

/** Record a new switch, unless one stands. Answers whether it is recorded. */
export async function insertSwitch(db: RelationalStore, sw: Omit<EmbeddingSwitch, 'state' | 'reason' | 'retryAt' | 'failures' | 'progressedAt'>, now: number): Promise<boolean> {
  return insertStoredSwitch(db, { ...sw, fromModelKey: sw.fromModelKey ?? NONE }, now);
}

/** Pause the building switch `id`, saying why. Answers whether it had been building. */
export async function pauseSwitch(db: RelationalStore, id: string, reason: string, now: number): Promise<boolean> {
  return pauseStoredSwitch(db, id, reason, now);
}

/** Hold the building switch `id` off its model until `until`, saying why, and count the failure. Answers whether it is building. */
export async function waitSwitch(db: RelationalStore, id: string, until: number, reason: string, now: number): Promise<boolean> {
  return waitStoredSwitch(db, id, until, reason, now);
}

/** Record that the switch `id`'s model wrote a vector: when, and that its failures in a row are over. */
export async function recordSwitchProgress(db: RelationalStore, id: string, now: number): Promise<void> {
  await progressStoredSwitch(db, id, now);
}

/** Resume the switch `id`, paused or held off its model: its model is asked at once. Answers whether it is resumed. */
export async function resumeSwitch(db: RelationalStore, id: string, now: number): Promise<boolean> {
  return resumeStoredSwitch(db, id, now);
}

/** End the switch `id` without moving search. Answers whether a switch of that id ended. */
export async function deleteSwitch(db: RelationalStore, id: string): Promise<boolean> {
  return deleteStoredSwitch(db, id);
}

/** Why a recovered copy of a server holds the switch it carries: the admin who confirmed it confirmed it on the original. */
export const RECOVERED_SWITCH = 'This server was recovered from a copy, so the switch waits for you. Resume it to keep rebuilding search, or cancel it.';

/**
 * Pause a switch a recovered copy of a Deployment carries, saying why: a recovered server does not spend on a switch
 * until an admin confirms it there. The store may predate the switch's schema step, in which case it holds none.
 */
export async function holdRecoveredSwitch(db: RelationalStore, now: number): Promise<void> {
  await holdStoredSwitch(db, RECOVERED_SWITCH, now);
}

/** Whether a Project is archived. */
export async function projectArchived(db: RelationalStore, projectId: string): Promise<boolean> {
  return storedProjectArchived(db, projectId);
}
