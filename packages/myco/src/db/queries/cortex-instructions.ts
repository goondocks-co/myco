import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';

const CORTEX_INSTRUCTION_COLUMNS = [
  'id',
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
    agent_id: row.agent_id as string,
    content: row.content as string,
    input_hash: row.input_hash as string,
    source_run_id: (row.source_run_id as string) ?? null,
    generated_at: row.generated_at as number,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

export function upsertCortexInstructions(input: CortexInstructionsUpsert): CortexInstructionsRow {
  const db = getDatabase();
  const id = input.id ?? `${input.agent_id}:${DEFAULT_CORTEX_INSTRUCTIONS_ID}`;

  db.prepare(
    `INSERT INTO cortex_instructions (
       id, agent_id, content, input_hash, source_run_id, generated_at, machine_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?
     )
     ON CONFLICT (id) DO UPDATE SET
       content = EXCLUDED.content,
       input_hash = EXCLUDED.input_hash,
       source_run_id = EXCLUDED.source_run_id,
       generated_at = EXCLUDED.generated_at,
       machine_id = EXCLUDED.machine_id`,
  ).run(
    id,
    input.agent_id,
    input.content,
    input.input_hash,
    input.source_run_id ?? null,
    input.generated_at,
    input.machine_id ?? getTeamMachineId(),
  );

  const row = toCortexInstructionsRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM cortex_instructions WHERE id = ?`).get(id) as Record<string, unknown>,
  );
  return row;
}

export function getCortexInstructions(agentId: string): CortexInstructionsRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM cortex_instructions
     WHERE agent_id = ?
     ORDER BY generated_at DESC
     LIMIT 1`,
  ).get(agentId) as Record<string, unknown> | undefined;
  return row ? toCortexInstructionsRow(row) : null;
}
