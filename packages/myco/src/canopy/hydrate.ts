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
 * Parse the synthesized canopy record_id of the form `${project_id}:${path}`.
 * Project IDs cannot contain `:`; paths can.
 *
 * Returns null if the id is malformed (no colon, leading colon, or trailing colon).
 */
export function parseCanopyRecordId(id: string): { projectId: string; path: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0 || idx === id.length - 1) return null;
  return { projectId: id.slice(0, idx), path: id.slice(idx + 1) };
}

/**
 * Resolve `(project_id, path)` from a synthesized canopy record id and
 * return the row's `llm_description`. Returns null when the id is malformed
 * or the row is missing.
 */
export function hydrateCanopyDescription(syntheticId: string): string | null {
  const parsed = parseCanopyRecordId(syntheticId);
  if (parsed === null) return null;
  const row = getDatabase().prepare(
    `SELECT llm_description FROM canopy_entries WHERE project_id = ? AND path = ?`,
  ).get(parsed.projectId, parsed.path) as { llm_description: string | null } | undefined;
  return row?.llm_description ?? null;
}

/**
 * Batched companion to `hydrateCanopyDescription` — given a list of synthesized
 * canopy record ids, fetch all matching `llm_description` values in a single
 * SQL query. Returns a Map keyed by the synthetic id.
 *
 * Used by canopy search paths to avoid the N+1 query pattern of per-row
 * hydration. Malformed ids are silently dropped from the result; missing rows
 * (or rows with NULL llm_description) are absent from the Map. Callers should
 * default missing keys to null.
 */
export function hydrateCanopyDescriptionsBatch(ids: string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  const parsed: Array<{ id: string; projectId: string; path: string }> = [];
  for (const id of ids) {
    const r = parseCanopyRecordId(id);
    if (r) parsed.push({ id, projectId: r.projectId, path: r.path });
  }
  if (parsed.length === 0) return new Map();
  const placeholders = parsed.map(() => '(?, ?)').join(', ');
  const args = parsed.flatMap((p) => [p.projectId, p.path]);
  const rows = getDatabase().prepare(
    `SELECT project_id, path, llm_description
       FROM canopy_entries
      WHERE (project_id, path) IN (VALUES ${placeholders})`,
  ).all(...args) as Array<{ project_id: string; path: string; llm_description: string | null }>;
  const lookup = new Map<string, string | null>();
  for (const row of rows) lookup.set(`${row.project_id}:${row.path}`, row.llm_description);
  const out = new Map<string, string>();
  for (const p of parsed) {
    const desc = lookup.get(p.id);
    if (typeof desc === 'string') out.set(p.id, desc);
  }
  return out;
}
