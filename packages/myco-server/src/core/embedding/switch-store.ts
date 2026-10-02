/**
 * The Deployment's embedding model switch, as stored: at most one row, read, started, paused, resumed and ended only
 * through this module.
 */
import type { PreparedStatement, RelationalStore } from '../adapters.js';
import { isEmbeddingProvider, type EmbeddingProviderId } from '@goondocks/myco-shared/settings-contract';
import { PASSED_OVER, RECEIPT, passedOverBinds } from './reconcile.js';

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

/** True while the switch `id` stands and is building. Binds: the switch id. */
const BUILDING_SQL = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ? AND state = 'building')`;

/** Source `s` belongs to a Project that is not archived: the sources a switch builds and counts. Binds nothing. */
const COUNTED_SOURCE = `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)`;

/** Source `s` holds an indexed vector under a model. Binds: the model key. */
const BUILT_SOURCE = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${RECEIPT.ready})`;

/** Counted sources neither built under a model nor passed over under it. Binds: `unbuiltBinds(modelKey, now)`. */
export const UNBUILT_SOURCES = `SELECT 1 FROM embedding_sources s WHERE ${COUNTED_SOURCE} AND NOT ${BUILT_SOURCE} AND NOT ${PASSED_OVER}`;
const unbuiltBinds = (modelKey: string, now: number): Array<string | number> => [modelKey, ...passedOverBinds(modelKey, now)];

/**
 * The condition every statement of a switch's completion carries: it is still building, and no counted source is left
 * unbuilt as of `now`. Binds: the switch id, then `unbuiltBinds`.
 */
export const completionCondition = (sw: EmbeddingSwitch, now: number): { sql: string; params: Array<string | number> } =>
  ({ sql: `${BUILDING_SQL} AND NOT EXISTS (${UNBUILT_SOURCES})`, params: [sw.id, ...unbuiltBinds(sw.modelKey, now)] });

/** The statement that ends a completed switch, carrying `completionCondition`. The sources it passed over stay recorded. */
export const completionStatements = (db: RelationalStore, sw: EmbeddingSwitch, now: number): PreparedStatement[] => {
  const condition = completionCondition(sw, now);
  return [db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND ${condition.sql}`).bind(...condition.params)];
};

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

/** The counted sources, and those holding an indexed vector under the switch's model. */
export async function switchProgress(db: RelationalStore, modelKey: string): Promise<{ built: number; total: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${BUILT_SOURCE}), 0) AS built FROM embedding_sources s WHERE ${COUNTED_SOURCE}`)
    .bind(modelKey).first<{ total: number; built: number }>();
  return { built: row?.built ?? 0, total: row?.total ?? 0 };
}

/** The counted sources a new model would read, and their characters, with a blob-backed plan read up to its bounded prefix of `prefixChars`. */
export async function sourceTotals(db: RelationalStore, prefixChars: number): Promise<{ sources: number; characters: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text), 0), ?) ELSE ? END), 0) AS chars
    FROM embedding_sources s WHERE ${COUNTED_SOURCE}`).bind(prefixChars, prefixChars).first<{ sources: number; chars: number }>();
  return { sources: row?.sources ?? 0, characters: row?.chars ?? 0 };
}

/** Whether every counted source holds an indexed vector under the model or is passed over under it. */
export async function switchComplete(db: RelationalStore, modelKey: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT NOT EXISTS (${UNBUILT_SOURCES}) AS complete`).bind(...unbuiltBinds(modelKey, now)).first<{ complete: number }>();
  return row?.complete === 1;
}

/** Whether a Project is archived. */
export async function projectArchived(db: RelationalStore, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT archived_at FROM projects WHERE project_id = ?`).bind(projectId).first<{ archived_at: number | null }>();
  return row !== null && row.archived_at !== null;
}
