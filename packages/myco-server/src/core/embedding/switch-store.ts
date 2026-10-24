export { core_embedding_switch_store_switchProgress as switchProgress, core_embedding_switch_store_sourceTotals as sourceTotals, core_embedding_switch_store_switchComplete as switchComplete } from "../../read/view-store.js";
/**
 * The Deployment's embedding model switch, as stored: at most one row, read, started, paused, resumed and ended only
 * through this module.
 */
import type { PreparedStatement, RelationalStore } from '../adapters.js';
import { isEmbeddingProvider, type EmbeddingProviderId } from '@goondocks/myco-shared/settings-contract';


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

interface SwitchRow {
  id: string; provider: string; model: string; endpoint: string | null; model_key: string; from_model_key: string;
  estimated_tokens: number; estimated_sources: number; state: string; reason: string | null; retry_at: number | null; failures: number; progressed_at: number; started_at: number; started_by: string;
}

/** The stored `from_model_key` of a switch begun with no model in use. */
const NONE = '';

/** True while a switch stands. Binds nothing. */
export const SWITCH_STANDS_SQL = `EXISTS (SELECT 1 FROM embedding_switches)`;

/** The switch under way, or null. A row naming a provider this release does not know reads as paused, saying so. */
export async function readSwitch(db: RelationalStore): Promise<EmbeddingSwitch | null> {
  const row = await db.prepare(`SELECT id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, estimated_sources, state, reason, retry_at, failures, progressed_at, started_at, started_by
    FROM embedding_switches WHERE slot = 'deployment'`).first<SwitchRow>();
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
  const inserted = await db.prepare(`INSERT INTO embedding_switches (slot, id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, estimated_sources, state, reason, progressed_at, started_at, started_by, updated_at)
    VALUES ('deployment', ?, ?, ?, ?, ?, ?, ?, ?, 'building', NULL, ?, ?, ?, ?) ON CONFLICT(slot) DO NOTHING`)
    .bind(sw.id, sw.provider, sw.model, sw.endpoint, sw.modelKey, sw.fromModelKey ?? NONE, sw.estimatedTokens, sw.estimatedSources, sw.startedAt, sw.startedAt, sw.startedBy, now).run();
  return inserted.meta.changes === 1;
}

/** Pause the building switch `id`, saying why. Answers whether it had been building. */
export async function pauseSwitch(db: RelationalStore, id: string, reason: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET state = 'paused', reason = ?, retry_at = NULL, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND state = 'building'`).bind(reason, now, id).run();
  return result.meta.changes === 1;
}

/** Hold the building switch `id` off its model until `until`, saying why, and count the failure. Answers whether it is building. */
export async function waitSwitch(db: RelationalStore, id: string, until: number, reason: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET retry_at = ?, reason = ?, failures = failures + 1, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND state = 'building'`).bind(until, reason, now, id).run();
  return result.meta.changes === 1;
}

/** Record that the switch `id`'s model wrote a vector: when, and that its failures in a row are over. */
export async function recordSwitchProgress(db: RelationalStore, id: string, now: number): Promise<void> {
  await db.prepare(`UPDATE embedding_switches SET progressed_at = ?, retry_at = NULL, reason = NULL, failures = 0, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND state = 'building'`).bind(now, now, id).run();
}

/** Resume the switch `id`, paused or held off its model: its model is asked at once. Answers whether it is resumed. */
export async function resumeSwitch(db: RelationalStore, id: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET state = 'building', reason = NULL, retry_at = NULL, failures = 0, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND (state = 'paused' OR retry_at IS NOT NULL)`).bind(now, id).run();
  return result.meta.changes === 1;
}

/** End the switch `id` without moving search. Answers whether a switch of that id ended. */
export async function deleteSwitch(db: RelationalStore, id: string): Promise<boolean> {
  const ended = await db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND id = ?`).bind(id).run();
  return ended.meta.changes === 1;
}

/** Why a recovered copy of a server holds the switch it carries: the admin who confirmed it confirmed it on the original. */
export const RECOVERED_SWITCH = 'This server was recovered from a copy, so the switch waits for you. Resume it to keep rebuilding search, or cancel it.';

/**
 * Pause a switch a recovered copy of a Deployment carries, saying why: a recovered server does not spend on a switch
 * until an admin confirms it there. The store may predate the switch's schema step, in which case it holds none.
 */
export async function holdRecoveredSwitch(db: RelationalStore, now: number): Promise<void> {
  const held = await db.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'embedding_switches'`).first<{ found: number }>();
  if (held === null) return;
  await db.prepare(`UPDATE embedding_switches SET state = 'paused', reason = ?, retry_at = NULL, updated_at = ? WHERE slot = 'deployment'`).bind(RECOVERED_SWITCH, now).run();
}

/** Whether a Project is archived. */
export async function projectArchived(db: RelationalStore, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT archived_at FROM projects WHERE project_id = ?`).bind(projectId).first<{ archived_at: number | null }>();
  return row !== null && row.archived_at !== null;
}
