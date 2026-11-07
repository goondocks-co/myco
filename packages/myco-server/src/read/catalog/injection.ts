import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";

export function injectionServedIds(db: sessions_import_RelationalStore, column: 'spore_ids' | 'plan_ids') {
  return db.prepare(`SELECT ${column} AS ids FROM spore_injections WHERE project_id = ? AND session_id = ?`);
}

export function injectionPromptHeld(db: sessions_import_RelationalStore) {
  return db.prepare(`SELECT 1 AS held FROM spore_injections WHERE project_id = ? AND session_id = ? AND prompt_id = ? AND prompt_hash <> ?`);
}
