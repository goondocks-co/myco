import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

/** The current instructions an agent generated for a project, and the run that produced them. */
export interface InstructionsRow {
  id: string;
  agentId: string;
  content: string;
  inputHash: string;
  sourceRunId: string | null;
  generatedAt: number;
}

/** Every current instructions row for the project, newest first. The store keeps one row per instructions id and replaces it in place, so this is the whole history that exists. */
export async function listInstructions(db: RelationalStore, scope: ReadScope): Promise<InstructionsRow[]> {
  const { results } = await db
    .prepare(`SELECT id, agent_id AS agentId, content, input_hash AS inputHash, source_run_id AS sourceRunId, generated_at AS generatedAt
       FROM cortex_instructions WHERE project_id = ? ORDER BY generated_at DESC, id ASC`)
    .bind(scope.projectId)
    .all<InstructionsRow>();
  return results.map((r) => ({ ...r, sourceRunId: r.sourceRunId ?? null }));
}

/** The hash of the material behind the newest instructions the project holds, or null where it holds none. A dispatch compares its own build against this. */
export async function newestInstructionsHash(db: RelationalStore, scope: ReadScope): Promise<string | null> {
  const row = await db
    .prepare(`SELECT input_hash AS inputHash FROM cortex_instructions WHERE project_id = ? ORDER BY generated_at DESC, id ASC LIMIT 1`)
    .bind(scope.projectId)
    .first<{ inputHash: string }>();
  return row?.inputHash ?? null;
}

/** The newest instructions the project holds, whichever agent wrote it; ties fall to the lower id. */
export async function newestInstructions(db: RelationalStore, scope: ReadScope): Promise<{ content: string; generatedAt: number } | null> {
  return db
    .prepare(`SELECT content, generated_at AS generatedAt
       FROM cortex_instructions WHERE project_id = ? ORDER BY generated_at DESC, id ASC LIMIT 1`)
    .bind(scope.projectId)
    .first<{ content: string; generatedAt: number }>();
}
