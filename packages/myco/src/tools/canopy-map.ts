/**
 * canopy_map — return the rendered project map.
 *
 * Reads the canopy_maps row for (project_id, machine_id) directly from the
 * vault DB. Returns an empty-state envelope when no map has been generated
 * yet so callers can render a friendly hint instead of erroring.
 */

import { readCanopyMap } from '@myco/canopy/map/store.js';

export interface CanopyMapHandlerArgs {
  projectId: string;
  machineId: string;
}

export interface CanopyMapResult {
  content: string;
  generated_at?: number;
  token_estimate?: number;
  is_empty?: true;
  message?: string;
}

const EMPTY_STATE_MESSAGE =
  'No project map yet. Canopy is generating one in the background; try again in a few minutes.';

export function emptyCanopyMap(message: string = EMPTY_STATE_MESSAGE): CanopyMapResult {
  return { content: '', is_empty: true, message };
}

export async function handleCanopyMap(args: CanopyMapHandlerArgs): Promise<CanopyMapResult> {
  const row = readCanopyMap(args.projectId, args.machineId);
  if (!row) return emptyCanopyMap();
  return {
    content: row.content,
    generated_at: row.generated_at,
    token_estimate: row.token_estimate,
  };
}
