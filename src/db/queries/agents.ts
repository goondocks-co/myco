/**
 * Agent CRUD query helpers.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
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

/** Normalize a PGlite result row into a typed AgentRow. */
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
export async function registerAgent(data: AgentInsert): Promise<AgentRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13, $14
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
       updated_at         = EXCLUDED.updated_at
     RETURNING ${SELECT_COLUMNS}`,
    [
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
    ],
  );

  return toAgentRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single agent by id.
 *
 * @returns the agent row, or null if not found.
 */
export async function getAgent(id: string): Promise<AgentRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM agents WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toAgentRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List all agents, ordered by created_at ASC.
 */
export async function listAgents(): Promise<AgentRow[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM agents
     ORDER BY created_at ASC`,
  );

  return (result.rows as Record<string, unknown>[]).map(toAgentRow);
}
