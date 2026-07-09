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
  'skill_lineage',
  'skill_usage',
  'knowledge_release_state',
  'team_members',
  'okf_generations',
  'okf_pages',
  'okf_page_revisions',
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
  skill_lineage: 'project',
  skill_usage: 'project',
  knowledge_release_state: 'project',
  team_members: 'machine',
  okf_generations: 'project',
  okf_pages: 'project',
  okf_page_revisions: 'project',
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

/**
 * Whether the worker should stamp a row's `synced_at` with its own receive
 * time at ingestion (rather than honoring whatever value came over the wire).
 *
 * True for machine-scoped tables (team_members). Their `synced_at` is set
 * locally on the daemon only AFTER a successful push, so the value serialized
 * into the outbox payload is always NULL — leaving the roster's "last
 * received" provenance blank. Stamping at ingestion makes `synced_at`
 * server-authoritative ("when the worker last received this row").
 *
 * False for project-scoped rows, which keep their existing wire semantics so
 * drift/other consumers that read `synced_at` are unaffected.
 */
export function stampSyncedAtAtIngestion(table: string): boolean {
  return SYNCED_TABLE_SCOPE[table as SyncedTable] === 'machine';
}
