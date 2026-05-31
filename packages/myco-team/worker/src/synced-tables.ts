/**
 * Authoritative list of tables the team-sync worker accepts records for.
 *
 * This is the single source of truth for "what gets pushed to D1". It lives
 * in its own dependency-free module (no `agents`/Cloudflare imports) for two
 * reasons:
 *
 *   1. The worker's `index.ts` imports it so the runtime enqueue/validate
 *      path uses exactly this set.
 *   2. The daemon package's cross-package parity test
 *      (`tests/db/synced-table-parity.test.ts`) imports it by relative path
 *      to assert the daemon's own table lists haven't drifted from it. The
 *      full `index.ts` cannot be imported into a daemon-package test because
 *      its transitive `agents/mcp` import pulls in `cloudflare:email`, which
 *      only resolves inside the Workers runtime. Keeping the list here lets
 *      the test import the REAL value rather than a checked-in copy that
 *      could go stale.
 *
 * Adding a synced table here is the trigger that the parity test watches:
 * the daemon's OBSERVED set must match this list (modulo named exclusions),
 * or CI fails naming the offending table.
 */
export const SYNCED_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'skill_candidates',
  'skill_records',
  'skill_usage',
  'knowledge_release_state',
  'team_members',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

/**
 * Scope of each synced table — the single source of truth for project- vs
 * machine-scoped handling. Project-scoped rows carry a grove project_id and
 * route to the team that owns the project. Machine-scoped rows (one set per
 * machine, e.g. the team_members self-row) carry no project_id and fan out to
 * every team the machine has joined. Derive ALL scope-specific behavior from
 * this map so a new table's scope is declared in exactly one place.
 *
 * The `Record<SyncedTable, ...>` type forces every SYNCED_TABLES entry to be
 * scoped here: adding a synced table without declaring its scope is a compile
 * error.
 */
export const SYNCED_TABLE_SCOPE: Record<SyncedTable, 'project' | 'machine'> = {
  sessions: 'project',
  prompt_batches: 'project',
  spores: 'project',
  entities: 'project',
  graph_edges: 'project',
  entity_mentions: 'project',
  resolution_events: 'project',
  plans: 'project',
  artifacts: 'project',
  digest_extracts: 'project',
  skill_candidates: 'project',
  skill_records: 'project',
  skill_usage: 'project',
  knowledge_release_state: 'project',
  team_members: 'machine',
};

/**
 * Synced tables that are MACHINE-scoped (one row set per machine, not per
 * project) and therefore carry no `project_id`. The worker's enqueue gate
 * exempts these from the grove-project_id validation. Derived from
 * SYNCED_TABLE_SCOPE so scope is declared in exactly one place.
 */
export const MACHINE_SCOPED_TABLES = SYNCED_TABLES.filter(
  (t) => SYNCED_TABLE_SCOPE[t] === 'machine',
);

/**
 * Whether a synced table's records must carry a valid grove project_id.
 * False for machine-scoped tables (team_members), which legitimately have
 * a null project_id.
 */
export function requiresGroveProjectId(table: string): boolean {
  return SYNCED_TABLE_SCOPE[table as SyncedTable] !== 'machine';
}
