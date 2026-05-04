import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';

const CORTEX_INSTRUCTION_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'content',
  'input_hash',
  'source_run_id',
  'generated_at',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = CORTEX_INSTRUCTION_COLUMNS.join(', ');
const DEFAULT_CORTEX_INSTRUCTIONS_ID = 'session-start';

export interface CortexInstructionsUpsert {
  project_id?: string | null;
  agent_id: string;
  content: string;
  input_hash: string;
  generated_at: number;
  id?: string;
  machine_id?: string;
  source_run_id?: string | null;
}

export interface CortexInstructionsRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  content: string;
  input_hash: string;
  source_run_id: string | null;
  generated_at: number;
  machine_id: string;
  synced_at: number | null;
}

function toCortexInstructionsRow(row: Record<string, unknown>): CortexInstructionsRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    content: row.content as string,
    input_hash: row.input_hash as string,
    source_run_id: (row.source_run_id as string) ?? null,
    generated_at: row.generated_at as number,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  return projectId ?? null;
}

function cortexInstructionIdentityWhere(projectId: string | null): { where: string; params: unknown[] } {
  return projectId === null
    ? { where: 'project_id IS NULL AND id = ?', params: [] }
    : { where: 'project_id = ? AND id = ?', params: [projectId] };
}

export function upsertCortexInstructions(input: CortexInstructionsUpsert): CortexInstructionsRow {
  const db = getDatabase();
  const projectId = normalizeProjectId(input.project_id);
  const id = input.id ?? `${input.agent_id}:${DEFAULT_CORTEX_INSTRUCTIONS_ID}`;
  const machineId = input.machine_id ?? getTeamMachineId();
  const identity = cortexInstructionIdentityWhere(projectId);
  const identityParams = [...identity.params, id];

  const row = db.transaction(() => {
    const existing = db.prepare(
      `SELECT rowid FROM cortex_instructions WHERE ${identity.where}`,
    ).get(...identityParams) as { rowid: number } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE cortex_instructions
         SET agent_id = ?,
             content = ?,
             input_hash = ?,
             source_run_id = ?,
             generated_at = ?,
             machine_id = ?
         WHERE rowid = ?`,
      ).run(
        input.agent_id,
        input.content,
        input.input_hash,
        input.source_run_id ?? null,
        input.generated_at,
        machineId,
        existing.rowid,
      );
    } else {
      db.prepare(
        `INSERT INTO cortex_instructions (
           id, project_id, agent_id, content, input_hash, source_run_id, generated_at, machine_id
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      ).run(
        id,
        projectId,
        input.agent_id,
        input.content,
        input.input_hash,
        input.source_run_id ?? null,
        input.generated_at,
        machineId,
      );
    }

    return db.prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM cortex_instructions
       WHERE ${identity.where}`,
    ).get(...identityParams) as Record<string, unknown>;
  })();

  return toCortexInstructionsRow(row);
}

export function getCortexInstructions(agentId: string, projectIdInput?: string | null): CortexInstructionsRow | null {
  const db = getDatabase();
  const projectId = normalizeProjectId(projectIdInput);
  const projectWhere = projectId === null ? 'project_id IS NULL' : 'project_id = ?';
  const params = projectId === null ? [agentId] : [projectId, agentId];
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM cortex_instructions
     WHERE ${projectWhere} AND agent_id = ?
     ORDER BY generated_at DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toCortexInstructionsRow(row) : null;
}
