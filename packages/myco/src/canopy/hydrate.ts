/**
 * Canopy hydration helpers.
 *
 * Canopy vector rows are stored under a synthesized id of the form
 * `<project_id>:<path>` (split on the FIRST colon — paths may contain colons
 * on some platforms, project_ids do not). This module decodes the synthetic
 * id back into a `(project_id, path)` lookup against `canopy_entries` so
 * search consumers (the harness `vault_search_canopy` tool and the daemon
 * `/api/search` `type=canopy` branch) can hydrate `llm_description` straight
 * from the row instead of carrying it through the vector metadata.
 */

import { getDatabase } from '../db/client.js';

/**
 * Resolve `(project_id, path)` from a synthesized canopy record id and
 * return the row's `llm_description`. Returns null when the id is malformed
 * or the row is missing.
 */
export function hydrateCanopyDescription(syntheticId: string): string | null {
  const idx = syntheticId.indexOf(':');
  if (idx <= 0) return null;
  const projectId = syntheticId.slice(0, idx);
  const path = syntheticId.slice(idx + 1);
  const row = getDatabase().prepare(
    `SELECT llm_description FROM canopy_entries WHERE project_id = ? AND path = ?`,
  ).get(projectId, path) as { llm_description: string | null } | undefined;
  return row?.llm_description ?? null;
}
