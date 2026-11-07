import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import type { PreparedStatement as core_embedding_switch_store_import_PreparedStatement } from "../../core/adapters.js";
import type { RelationalStore as core_embedding_switch_store_import_RelationalStore } from "../../core/adapters.js";
import { RECEIPT as core_embedding_switch_store_import_RECEIPT } from "../../core/embedding/reconcile.js";
import type { EmbeddingSwitch } from '../../core/embedding/switch-store.js';
import { core_embedding_reconcile_PASSED_OVER, core_embedding_reconcile_passedOverBinds } from './embedding-reconcile.js';

/** True while the switch `id` stands and is building. Binds: the switch id. */
const core_embedding_switch_store_BUILDING_SQL = `EXISTS (SELECT 1 FROM embedding_switches WHERE slot = 'deployment' AND id = ? AND state = 'building')`;

/** Source `s` belongs to a Project that is not archived: the sources a switch builds and counts. Binds nothing. */
const core_embedding_switch_store_COUNTED_SOURCE = `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)`;

/** Source `s` holds an indexed vector under a model. Binds: the model key. */
const core_embedding_switch_store_BUILT_SOURCE = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${core_embedding_switch_store_import_RECEIPT.ready})`;

/** Counted sources neither built under a model nor passed over under it. Binds: `unbuiltBinds(modelKey, now)`. */
const core_embedding_switch_store_UNBUILT_SOURCES = `SELECT 1 FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE} AND NOT ${core_embedding_switch_store_BUILT_SOURCE} AND NOT ${core_embedding_reconcile_PASSED_OVER}`;

const core_embedding_switch_store_unbuiltBinds = (modelKey: string, now: number): Array<string | number> => [modelKey, ...core_embedding_reconcile_passedOverBinds(modelKey, now)];

/**
 * The condition every statement of a switch's completion carries: it is still building, and no counted source is left
 * unbuilt as of `now`. Binds: the switch id, then `unbuiltBinds`.
 */
const core_embedding_switch_store_completionCondition = (sw: EmbeddingSwitch, now: number): { sql: string; params: Array<string | number> } =>
  ({ sql: `${core_embedding_switch_store_BUILDING_SQL} AND NOT EXISTS (${core_embedding_switch_store_UNBUILT_SOURCES})`, params: [sw.id, ...core_embedding_switch_store_unbuiltBinds(sw.modelKey, now)] });

/** The statement that ends a completed switch, carrying `completionCondition`. The sources it passed over stay recorded. */
const core_embedding_switch_store_completionStatements = (db: core_embedding_switch_store_import_RelationalStore, sw: EmbeddingSwitch, now: number): core_embedding_switch_store_import_PreparedStatement[] => {
  const condition = core_embedding_switch_store_completionCondition(sw, now);
  return [db.prepare(`DELETE FROM embedding_switches WHERE slot = 'deployment' AND ${condition.sql} RETURNING id`).bind(...condition.params)];
};

/** The counted sources, and those holding an indexed vector under the switch's model. */
async function core_embedding_switch_store_switchProgress(db: core_embedding_switch_store_import_RelationalStore, modelKey: string): Promise<{ built: number; total: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(${core_embedding_switch_store_BUILT_SOURCE}), 0) AS built FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE}`)
    .bind(modelKey).first<{ total: number; built: number }>();
  return { built: row?.built ?? 0, total: row?.total ?? 0 };
}

/** The counted sources a new model would read, and their characters, with a blob-backed plan read up to its bounded prefix of `prefixChars`. */
async function core_embedding_switch_store_sourceTotals(db: core_embedding_switch_store_import_RelationalStore, prefixChars: number): Promise<{ sources: number; characters: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS sources, COALESCE(SUM(CASE WHEN blob_key IS NULL THEN MIN(COALESCE(length(text), 0), ?) ELSE ? END), 0) AS chars
    FROM embedding_sources s WHERE ${core_embedding_switch_store_COUNTED_SOURCE}`).bind(prefixChars, prefixChars).first<{ sources: number; chars: number }>();
  return { sources: row?.sources ?? 0, characters: row?.chars ?? 0 };
}

/** Whether every counted source holds an indexed vector under the model or is passed over under it. */
async function core_embedding_switch_store_switchComplete(db: core_embedding_switch_store_import_RelationalStore, modelKey: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT NOT EXISTS (${core_embedding_switch_store_UNBUILT_SOURCES}) AS complete`).bind(...core_embedding_switch_store_unbuiltBinds(modelKey, now)).first<{ complete: number }>();
  return row?.complete === 1;
}

export function prepareSwitchEnd(db: sessions_import_RelationalStore, sw: EmbeddingSwitch, now: number) {
  return core_embedding_switch_store_completionStatements(db, sw, now);
}

export { core_embedding_switch_store_switchProgress, core_embedding_switch_store_sourceTotals, core_embedding_switch_store_switchComplete, core_embedding_switch_store_completionCondition };
