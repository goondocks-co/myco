/**
 * Agent CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when registering an agent. */
export interface AgentInsert {
  id: string;
  name: string;
  created_at: number;
  provider?: string | null;
  model?: string | null;
  system_prompt_hash?: string | null;
  config?: string | null;
  source?: string;
  system_prompt?: string | null;
  max_turns?: number | null;
  timeout_seconds?: number | null;
  tool_access?: string | null;
  enabled?: number;
  updated_at?: number | null;
}

/** Row shape returned from agent queries (all columns). */
export interface AgentRow {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  system_prompt_hash: string | null;
  config: string | null;
  source: string;
  system_prompt: string | null;
  max_turns: number | null;
  timeout_seconds: number | null;
  tool_access: string | null;
  enabled: number;
  created_at: number;
  updated_at: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default agent source for new agents. */
const DEFAULT_SOURCE = 'built-in';

/** Default enabled flag for new agents. */
const DEFAULT_ENABLED = 1;

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const AGENT_COLUMNS = [
  'id',
  'name',
  'provider',
  'model',
  'system_prompt_hash',
  'config',
  'source',
  'system_prompt',
  'max_turns',
  'timeout_seconds',
  'tool_access',
  'enabled',
  'created_at',
  'updated_at',
] as const;

const SELECT_COLUMNS = AGENT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed AgentRow. */
function toAgentRow(row: Record<string, unknown>): AgentRow {
  return {
    id: row.id as string,
    name: row.name as string,
    provider: (row.provider as string) ?? null,
    model: (row.model as string) ?? null,
    system_prompt_hash: (row.system_prompt_hash as string) ?? null,
    config: (row.config as string) ?? null,
    source: (row.source as string) ?? DEFAULT_SOURCE,
    system_prompt: (row.system_prompt as string) ?? null,
    max_turns: (row.max_turns as number) ?? null,
    timeout_seconds: (row.timeout_seconds as number) ?? null,
    tool_access: (row.tool_access as string) ?? null,
    enabled: (row.enabled as number) ?? DEFAULT_ENABLED,
    created_at: row.created_at as number,
    updated_at: (row.updated_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register an agent or update it if the id already exists.
 *
 * On conflict the row is updated with the values from `data`.
 * This is the idempotent upsert — calling twice with the same data
 * produces the same result.
 */
export function registerAgent(data: AgentInsert): AgentRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )
     ON CONFLICT (id) DO UPDATE SET
       name               = EXCLUDED.name,
       provider           = EXCLUDED.provider,
       model              = EXCLUDED.model,
       system_prompt_hash = EXCLUDED.system_prompt_hash,
       config             = EXCLUDED.config,
       source             = EXCLUDED.source,
       system_prompt      = EXCLUDED.system_prompt,
       max_turns          = EXCLUDED.max_turns,
       timeout_seconds    = EXCLUDED.timeout_seconds,
       tool_access        = EXCLUDED.tool_access,
       enabled            = EXCLUDED.enabled,
       updated_at         = EXCLUDED.updated_at`,
  ).run(
    data.id,
    data.name,
    data.provider ?? null,
    data.model ?? null,
    data.system_prompt_hash ?? null,
    data.config ?? null,
    data.source ?? DEFAULT_SOURCE,
    data.system_prompt ?? null,
    data.max_turns ?? null,
    data.timeout_seconds ?? null,
    data.tool_access ?? null,
    data.enabled ?? DEFAULT_ENABLED,
    data.created_at,
    data.updated_at ?? null,
  );

  return toAgentRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM agents WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
}

/**
 * Retrieve a single agent by id.
 *
 * @returns the agent row, or null if not found.
 */
export function getAgent(id: string): AgentRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agents WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toAgentRow(row);
}

/**
 * List all agents, ordered by created_at ASC.
 */
export function listAgents(): AgentRow[] {
  const db = getDatabase();

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agents
     ORDER BY created_at ASC`,
  ).all() as Record<string, unknown>[];

  return rows.map(toAgentRow);
}
