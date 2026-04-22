/**
 * Shared record-lookup helper for the MCP `myco_recall` tool and the plain
 * HTTP `/records/:type/:id` route. The MCP tool speaks singular (`session`),
 * the HTTP route speaks plural (`sessions`) to match daemon/outbox conventions;
 * both resolve to the same D1 table here.
 */

import type { Env } from './index';

const TYPE_TO_TABLE: Record<string, string> = {
  session: 'sessions',
  spore: 'spores',
  plan: 'plans',
  artifact: 'artifacts',
  skill: 'skill_records',
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
