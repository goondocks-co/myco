import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import type { EmbeddingSwitch } from '../../core/embedding/switch-store.js';
import { EMBEDDING_SELECTION_LEAVES as switchSettingLeaves, type StoredEmbedding as SwitchSettings } from '../../core/embedding/policy.js';
import { core_embedding_switch_store_completionCondition } from './embedding-switch-store.js';

export function prepareSwitchedSettings(db: sessions_import_RelationalStore, choice: SwitchSettings, actor: string, nowMs: number, sw: EmbeddingSwitch, stamps: ReadonlyMap<string, string>) {
  const condition = core_embedding_switch_store_completionCondition(sw, nowMs);
  const statements = switchSettingLeaves.flatMap((part) => {
    const value = choice[part];
    if (value !== undefined) {
      return [db.prepare(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by, write_id) SELECT ?, ?, ?, ?, ? WHERE ${condition.sql}
        ON CONFLICT(leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by, write_id = excluded.write_id`)
        .bind(part, JSON.stringify(value), nowMs, actor, crypto.randomUUID(), ...condition.params)];
    }
    return stamps.has(part) ? [
      db.prepare(`DELETE FROM deployment_settings WHERE leaf = ? AND ${condition.sql}`).bind(part, ...condition.params),
      db.prepare(`INSERT INTO deployment_setting_resets (leaf, reset_at, reset_by) SELECT ?, ?, ? WHERE ${condition.sql}
        ON CONFLICT(leaf) DO UPDATE SET reset_at = excluded.reset_at, reset_by = excluded.reset_by`).bind(part, nowMs, actor, ...condition.params),
    ] : [];
  });
  return statements;
}
