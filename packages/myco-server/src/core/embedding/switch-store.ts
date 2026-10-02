/**
 * The Deployment's embedding model switch, as stored: at most one row, read, started, paused, resumed and ended only
 * through this module.
 */
import type { PreparedStatement, RelationalStore } from '../adapters.js';
import { isEmbeddingProvider, type EmbeddingProviderId } from '@goondocks/myco-shared/settings-contract';
import { RECEIPT } from './reconcile.js';

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
  state: SwitchState;
  reason: string | null;
  startedAt: number;
  startedBy: string;
}

interface SwitchRow {
  id: string; provider: string; model: string; endpoint: string | null; model_key: string; from_model_key: string;
  estimated_tokens: number; state: string; reason: string | null; started_at: number; started_by: string;
}

/** The stored `from_model_key` of a switch begun with no model in use. */
const NONE = '';

/** True while a switch stands. Binds nothing. */
export const SWITCH_STANDS_SQL = `EXISTS (SELECT 1 FROM embedding_switches)`;

/** True while the switch `id` stands and is building. Binds: the switch id. */
const BUILDING_SQL = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ? AND state = 'building')`;

/**
 * Current sources with no indexed vector under a model, across the Deployment. Binds: the model key.
 */
export const UNBUILT_SOURCES = `SELECT 1 FROM embedding_sources s WHERE NOT EXISTS (SELECT 1 FROM embedding_receipts r
  WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id AND r.revision = s.revision
  AND r.model_key = ? AND r.ready = ${RECEIPT.ready})`;

/** The condition every statement of a switch's completion carries: it is still building, and every source holds a vector under its model. Binds: id, model key. */
export const completionCondition = (sw: EmbeddingSwitch): { sql: string; params: string[] } =>
  ({ sql: `${BUILDING_SQL} AND NOT EXISTS (${UNBUILT_SOURCES})`, params: [sw.id, sw.modelKey] });

/** The statement that ends a completed switch, carrying `completionCondition`. */
export const completionDelete = (db: RelationalStore, sw: EmbeddingSwitch): PreparedStatement => {
  const condition = completionCondition(sw);
  return db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND ${condition.sql}`).bind(...condition.params);
};

/** The switch under way, or null. A row naming a provider this release does not know reads as paused, saying so. */
export async function readSwitch(db: RelationalStore): Promise<EmbeddingSwitch | null> {
  const row = await db.prepare(`SELECT id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, state, reason, started_at, started_by
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
    state: known && row.state === 'building' ? 'building' : 'paused',
    reason: known ? row.reason : `This server does not offer ${row.provider}. Cancel the switch.`,
    startedAt: row.started_at,
    startedBy: row.started_by,
  };
}

/** Record a new switch, unless one stands. Answers whether it is recorded. */
export async function insertSwitch(db: RelationalStore, sw: Omit<EmbeddingSwitch, 'state' | 'reason'>, now: number): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO embedding_switches (slot, id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, state, reason, started_at, started_by, updated_at)
    VALUES ('deployment', ?, ?, ?, ?, ?, ?, ?, 'building', NULL, ?, ?, ?) ON CONFLICT(slot) DO NOTHING`)
    .bind(sw.id, sw.provider, sw.model, sw.endpoint, sw.modelKey, sw.fromModelKey ?? NONE, sw.estimatedTokens, sw.startedAt, sw.startedBy, now).run();
  return result.meta.changes === 1;
}

/** Pause the building switch `id`, saying why. Answers whether it had been building. */
export async function pauseSwitch(db: RelationalStore, id: string, reason: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET state = 'paused', reason = ?, updated_at = ? WHERE slot = 'deployment' AND id = ? AND state = 'building'`)
    .bind(reason, now, id).run();
  return result.meta.changes === 1;
}

/** Resume the paused switch `id`. Answers whether it had been paused. */
export async function resumeSwitch(db: RelationalStore, id: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET state = 'building', reason = NULL, updated_at = ? WHERE slot = 'deployment' AND id = ? AND state = 'paused'`)
    .bind(now, id).run();
  return result.meta.changes === 1;
}

/** End the switch `id` without moving search. Answers whether a switch of that id ended. */
export async function deleteSwitch(db: RelationalStore, id: string): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND id = ?`).bind(id).run();
  return result.meta.changes === 1;
}

/** Every current source, and those holding an indexed vector under the switch's model. */
export async function switchProgress(db: RelationalStore, modelKey: string): Promise<{ done: number; total: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(EXISTS (SELECT 1 FROM embedding_receipts r
      WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id AND r.revision = s.revision
      AND r.model_key = ? AND r.ready = ${RECEIPT.ready})), 0) AS done FROM embedding_sources s`).bind(modelKey).first<{ total: number; done: number }>();
  return { done: row?.done ?? 0, total: row?.total ?? 0 };
}

/** The characters a new model reads: every source's embedded text, with a blob-backed plan read up to its bounded prefix of `prefixChars`. */
export async function sourceCharacters(db: RelationalStore, prefixChars: number): Promise<number> {
  const row = await db.prepare(`SELECT COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text), 0), ?) ELSE ? END), 0) AS chars FROM embedding_sources`)
    .bind(prefixChars, prefixChars).first<{ chars: number }>();
  return row?.chars ?? 0;
}

/** Whether every current source holds an indexed vector under the model. */
export async function switchComplete(db: RelationalStore, modelKey: string): Promise<boolean> {
  const row = await db.prepare(`SELECT NOT EXISTS (${UNBUILT_SOURCES}) AS complete`).bind(modelKey).first<{ complete: number }>();
  return row?.complete === 1;
}
