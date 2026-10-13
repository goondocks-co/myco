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

/** Whether this run left the instructions row it owed. The close gate's evidence: a report is the model's claim, this is the row. */
export async function instructionsWrittenBy(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS one FROM cortex_instructions WHERE project_id = ? AND source_run_id = ? LIMIT 1`)
    .bind(scope.projectId, runId)
    .first<{ one: number }>();
  return row !== null;
}
