/**
 * The Deployment's embedding model switch, as stored: at most one row, read, started, paused, resumed and ended only
 * through this module, and the sources its model could not read.
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
  /** While building, the instant the new model is asked again after it failed, or null. */
  retryAt: number | null;
  /** The new model's failures in a row, counted from its last written vector. */
  failures: number;
  startedAt: number;
  startedBy: string;
}

interface SwitchRow {
  id: string; provider: string; model: string; endpoint: string | null; model_key: string; from_model_key: string;
  estimated_tokens: number; state: string; reason: string | null; retry_at: number | null; failures: number; started_at: number; started_by: string;
}

/** The stored `from_model_key` of a switch begun with no model in use. */
const NONE = '';

/** True while a switch stands. Binds nothing. */
export const SWITCH_STANDS_SQL = `EXISTS (SELECT 1 FROM embedding_switches)`;

/** True while the switch `id` stands and is building. Binds: the switch id. */
const BUILDING_SQL = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ? AND state = 'building')`;

/** Source `s` belongs to a Project that is not archived: the sources a switch builds and counts. Binds nothing. */
const COUNTED_SOURCE = `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)`;

/** Source `s`'s revision is one the switch's model could not read. Binds nothing. */
export const SKIPPED_SOURCE = `EXISTS (SELECT 1 FROM embedding_switch_skips k WHERE k.project_id = s.project_id AND k.type = s.type
  AND k.record_id = s.record_id AND k.revision = s.revision)`;

/** Source `s` holds an indexed vector under a model. Binds: the model key. */
const BUILT_SOURCE = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${RECEIPT.ready})`;

/** Counted sources neither built under a model nor skipped. Binds: the model key. */
export const UNBUILT_SOURCES = `SELECT 1 FROM embedding_sources s WHERE ${COUNTED_SOURCE} AND NOT ${BUILT_SOURCE} AND NOT ${SKIPPED_SOURCE}`;

/** The condition every statement of a switch's completion carries: it is still building, and no counted source is left unbuilt. Binds: id, model key. */
export const completionCondition = (sw: EmbeddingSwitch): { sql: string; params: string[] } =>
  ({ sql: `${BUILDING_SQL} AND NOT EXISTS (${UNBUILT_SOURCES})`, params: [sw.id, sw.modelKey] });

/**
 * The statements that end a completed switch: the switch row goes first, carrying `completionCondition`, and its skipped
 * sources after it, once no switch stands. The skips stay in place while the condition reads them.
 */
export const completionStatements = (db: RelationalStore, sw: EmbeddingSwitch): PreparedStatement[] => {
  const condition = completionCondition(sw);
  return [
    db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND ${condition.sql}`).bind(...condition.params),
    db.prepare(`DELETE FROM embedding_switch_skips WHERE NOT ${SWITCH_STANDS_SQL}`),
  ];
};

/** The switch under way, or null. A row naming a provider this release does not know reads as paused, saying so. */
export async function readSwitch(db: RelationalStore): Promise<EmbeddingSwitch | null> {
  const row = await db.prepare(`SELECT id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, state, reason, retry_at, failures, started_at, started_by
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
    retryAt: row.retry_at,
    failures: row.failures,
    startedAt: row.started_at,
    startedBy: row.started_by,
  };
}

/** Record a new switch, unless one stands. Answers whether it is recorded. */
export async function insertSwitch(db: RelationalStore, sw: Omit<EmbeddingSwitch, 'state' | 'reason' | 'retryAt' | 'failures'>, now: number): Promise<boolean> {
  const [, inserted] = await db.batch([
    db.prepare(`DELETE FROM embedding_switch_skips WHERE NOT ${SWITCH_STANDS_SQL}`),
    db.prepare(`INSERT INTO embedding_switches (slot, id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, state, reason, started_at, started_by, updated_at)
      VALUES ('deployment', ?, ?, ?, ?, ?, ?, ?, 'building', NULL, ?, ?, ?) ON CONFLICT(slot) DO NOTHING`)
      .bind(sw.id, sw.provider, sw.model, sw.endpoint, sw.modelKey, sw.fromModelKey ?? NONE, sw.estimatedTokens, sw.startedAt, sw.startedBy, now),
  ]);
  return inserted!.meta.changes === 1;
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

/** Clear the failures of the switch `id` once its model writes again. */
export async function clearSwitchWait(db: RelationalStore, id: string, now: number): Promise<void> {
  await db.prepare(`UPDATE embedding_switches SET retry_at = NULL, reason = NULL, failures = 0, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND state = 'building' AND (failures > 0 OR retry_at IS NOT NULL)`).bind(now, id).run();
}

/** Resume the paused switch `id`. Answers whether it had been paused. */
export async function resumeSwitch(db: RelationalStore, id: string, now: number): Promise<boolean> {
  const result = await db.prepare(`UPDATE embedding_switches SET state = 'building', reason = NULL, retry_at = NULL, failures = 0, updated_at = ?
    WHERE slot = 'deployment' AND id = ? AND state = 'paused'`).bind(now, id).run();
  return result.meta.changes === 1;
}

/** End the switch `id` without moving search, with the sources it skipped. Answers whether a switch of that id ended. */
export async function deleteSwitch(db: RelationalStore, id: string): Promise<boolean> {
  const stands = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ?)`;
  const [, ended] = await db.batch([
    db.prepare(`DELETE FROM embedding_switch_skips WHERE ${stands}`).bind(id),
    db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND id = ?`).bind(id),
  ]);
  return ended!.meta.changes === 1;
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

/** Record a source revision the switch `id`'s model could not read, while that switch stands. */
export async function recordSkip(db: RelationalStore, id: string, source: { projectId: string; type: string; recordId: string; revision: string }, reason: string, now: number): Promise<void> {
  await db.prepare(`INSERT INTO embedding_switch_skips (project_id, type, record_id, revision, reason, skipped_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ?)
    ON CONFLICT(project_id, type, record_id) DO UPDATE SET revision = excluded.revision, reason = excluded.reason, skipped_at = excluded.skipped_at`)
    .bind(source.projectId, source.type, source.recordId, source.revision, reason, now, id).run();
}

/** How far a switch's model has come over the counted sources: built, skipped, and every one. */
export async function switchProgress(db: RelationalStore, modelKey: string): Promise<{ done: number; skipped: number; total: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${BUILT_SOURCE}), 0) AS built,
      COALESCE(SUM(NOT ${BUILT_SOURCE} AND ${SKIPPED_SOURCE}), 0) AS skipped
    FROM embedding_sources s WHERE ${COUNTED_SOURCE}`).bind(modelKey, modelKey).first<{ total: number; built: number; skipped: number }>();
  return { done: (row?.built ?? 0) + (row?.skipped ?? 0), skipped: row?.skipped ?? 0, total: row?.total ?? 0 };
}

/** The reasons sources were skipped, each with how many, most first. */
export async function skipReasons(db: RelationalStore): Promise<Array<{ reason: string; count: number }>> {
  const { results } = await db.prepare(`SELECT reason, COUNT(*) AS count FROM embedding_switch_skips GROUP BY reason ORDER BY count DESC, reason`).all<{ reason: string; count: number }>();
  return results;
}

/** The last instant a vector landed under a model, or null. */
export async function lastBuiltAt(db: RelationalStore, modelKey: string): Promise<number | null> {
  const row = await db.prepare(`SELECT MAX(updated_at) AS at FROM embedding_receipts WHERE model_key = ? AND ready = ${RECEIPT.ready}`).bind(modelKey).first<{ at: number | null }>();
  return row?.at ?? null;
}

/** The counted sources a new model would read, and their characters, with a blob-backed plan read up to its bounded prefix of `prefixChars`. */
export async function sourceTotals(db: RelationalStore, prefixChars: number): Promise<{ sources: number; characters: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text), 0), ?) ELSE ? END), 0) AS chars
    FROM embedding_sources s WHERE ${COUNTED_SOURCE}`).bind(prefixChars, prefixChars).first<{ sources: number; chars: number }>();
  return { sources: row?.sources ?? 0, characters: row?.chars ?? 0 };
}

/** Whether every counted source holds an indexed vector under the model or is skipped. */
export async function switchComplete(db: RelationalStore, modelKey: string): Promise<boolean> {
  const row = await db.prepare(`SELECT NOT EXISTS (${UNBUILT_SOURCES}) AS complete`).bind(modelKey).first<{ complete: number }>();
  return row?.complete === 1;
}

/** Whether a Project is archived. */
export async function projectArchived(db: RelationalStore, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT archived_at FROM projects WHERE project_id = ?`).bind(projectId).first<{ archived_at: number | null }>();
  return row !== null && row.archived_at !== null;
}
