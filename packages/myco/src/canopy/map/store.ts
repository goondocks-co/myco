import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';

export interface CanopyMapRow {
  project_id: string;
  machine_id: string;
  content: string;
  inputs_hash: string;
  generated_at: number;
  generated_by_run_id: string | null;
  token_estimate: number;
}

export interface WriteCanopyMapInput {
  project_id: string;
  machine_id: string;
  content: string;
  inputs_hash: string;
  token_estimate: number;
  generated_by_run_id: string | null;
}

export function readCanopyMap(projectId: string, machineId: string): CanopyMapRow | null {
  const row = getDatabase().prepare(
    `SELECT project_id, machine_id, content, inputs_hash, generated_at, generated_by_run_id, token_estimate
       FROM canopy_maps
      WHERE project_id = ? AND machine_id = ?`,
  ).get(projectId, machineId) as CanopyMapRow | undefined;
  return row ?? null;
}

export function writeCanopyMap(input: WriteCanopyMapInput): void {
  getDatabase().prepare(
    `INSERT OR REPLACE INTO canopy_maps
       (project_id, machine_id, content, inputs_hash, generated_at, generated_by_run_id, token_estimate)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.project_id, input.machine_id, input.content, input.inputs_hash,
    epochSeconds(), input.generated_by_run_id, input.token_estimate,
  );
}
