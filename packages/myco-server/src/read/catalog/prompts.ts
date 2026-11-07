import type { RelationalStore as prompts_import_RelationalStore } from "../../core/adapters.js";
import { READ_ORIGINS as prompts_import_READ_ORIGINS } from "../extraction-origins.js";
import { notTombstonedSql as prompts_import_notTombstonedSql } from "../../db/session-read-model.js";
import type { ReadScope as prompts_import_ReadScope } from "../scope.js";

/** The captured session supporting an extraction finding, within the run's Project. */
async function prompts_extractionSourceSession(db: prompts_import_RelationalStore, scope: prompts_import_ReadScope, promptId: string): Promise<string | null> {
  const source = await db.prepare(`SELECT p.session_id AS sessionId FROM session_prompts p
    JOIN session_documents d ON d.project_id = p.project_id AND d.session_id = p.session_id AND d.generation = p.generation AND d.state = 'live'
    JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
    WHERE p.project_id = ? AND p.prompt_id = ? AND p.origin IN (${prompts_import_READ_ORIGINS.map(() => '?').join(', ')}) AND ${prompts_import_notTombstonedSql('s')}`)
    .bind(scope.projectId, promptId, ...prompts_import_READ_ORIGINS).first<{ sessionId: string }>();
  return source?.sessionId ?? null;
}

export { prompts_extractionSourceSession };
