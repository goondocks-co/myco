import type { RelationalStore as extraction_coverage_import_RelationalStore } from "../../core/adapters.js";
import type { ReadScope as extraction_coverage_import_ReadScope } from "../scope.js";

/** Historical flags and durable record acknowledgements each have an indexed existence probe. */
const extraction_coverage_ACKNOWLEDGED_PROMPTS_SQL = `SELECT 1 AS found FROM extraction_acks WHERE project_id = ? LIMIT 1`;

async function extraction_coverage_hasAcknowledgedPrompts(db: extraction_coverage_import_RelationalStore, scope: extraction_coverage_import_ReadScope): Promise<boolean> {
  return await db.prepare(extraction_coverage_ACKNOWLEDGED_PROMPTS_SQL)
    .bind(scope.projectId).first() !== null;
}

export { extraction_coverage_hasAcknowledgedPrompts };
