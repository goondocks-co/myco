/**
 * Shared D1 record-lookup helper.
 *
 * Backs both the MCP `myco_recall` tool and the plain HTTP `/records/:type/:id`
 * route. Keeping the TYPE_TO_TABLE map and the SELECT query in one place makes
 * the two surfaces impossible to drift apart.
 */

import type { Env } from './index';

/**
 * Mapping from the external `type` discriminator to the D1 table name.
 *
 * The MCP tool exposes the singular form (`session`, `spore`, ...) for
 * backwards compat with the old `myco_get`. The HTTP route exposes the plural
 * form (`sessions`, `spores`, ...) because it mirrors how the daemon talks
 * about tables everywhere else (search namespace, outbox `table_name`, etc).
 *
 * Both spellings resolve to the same table — `fetchRecord` accepts either.
 */
const TYPE_TO_TABLE: Record<string, string> = {
  // singular — matches the old myco_get MCP schema
  session: 'sessions',
  spore: 'spores',
  plan: 'plans',
  artifact: 'artifacts',
  skill: 'skill_records',
  // plural — matches daemon / HTTP conventions
  sessions: 'sessions',
  spores: 'spores',
  plans: 'plans',
  artifacts: 'artifacts',
  skill_records: 'skill_records',
};

/** Allowed `type` values the HTTP route accepts (plural form only). */
export const ALLOWED_RECORD_TYPES = ['sessions', 'spores', 'plans', 'artifacts', 'skill_records'] as const;
export type AllowedRecordType = (typeof ALLOWED_RECORD_TYPES)[number];

export function isAllowedRecordType(value: string): value is AllowedRecordType {
  return (ALLOWED_RECORD_TYPES as readonly string[]).includes(value);
}

export function resolveTable(type: string): string | null {
  return TYPE_TO_TABLE[type] ?? null;
}

/**
 * Fetch a single record by id from the D1 table associated with `type`.
 *
 * @returns the row (plain object), or `null` if the type is unknown or no row
 * matches. Never throws on a miss — callers treat that as a fallback signal.
 */
export async function fetchRecord(
  env: Pick<Env, 'MYCO_TEAM_DB'>,
  type: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const table = resolveTable(type);
  if (!table) return null;
  const row = await env.MYCO_TEAM_DB
    .prepare(`SELECT * FROM ${table} WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<Record<string, unknown>>();
  return row ?? null;
}
