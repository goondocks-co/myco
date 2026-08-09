/**
 * Residency apply engine (Phase F) — the ONE per-table rule matrix both transition
 * directions run.
 *
 * Attach ingest (T2, `host/routed-residency.ts`) applies rows a member pushed to the
 * host's served Grove; detach apply (T4, member side) applies rows the member pulled
 * back into its local Grove. Both must converge on the SAME end state under the SAME
 * rules, so the engine lives here — DB-layer, transport-free — and each side wraps it
 * in its own transaction + HTTP/staging shell.
 *
 * The residency set spans three write disciplines a single upsert cannot serve:
 *
 *   - **if-newer** (spores, plans, artifacts, skills, OKF, release state, entities):
 *     a monotonic timestamp orders versions, so a batch that arrives out of date
 *     never regresses the target — the older row is skipped, not written, and still
 *     counts as applied.
 *   - **insert-only** (append-only logs: resolution/lineage/usage/revisions/edges):
 *     rows are immutable once written, so a de-duping insert is correct and a replay
 *     is a no-op.
 *   - **field-merge** (`sessions`, `prompt_batches`): neither carries an `updated_at`
 *     and both mutate heavily post-insert (title/summary enrichment, activity counts,
 *     status transitions), so a whole-row replace would clobber one side's enrichment
 *     with the other's stub. These merge per field: prefer a non-null incoming
 *     enrichment value, take the NULL-safe max of monotonic counters, and never
 *     regress a terminal status to an in-flight one.
 *   - **local-rowid** (`activities`, the agent-run child tables, `log_entries`,
 *     `knowledge_git_provenance`, `digest_extract_revisions`): the row's `id` is an
 *     `INTEGER PRIMARY KEY AUTOINCREMENT` — a counter private to the machine that
 *     wrote it, so member A's `activities` row 42 and member B's row 42 are unrelated
 *     rows that both claim the same key. An id-keyed upsert would silently merge them.
 *     These ship WITHOUT their id and the receiver assigns its own; identity comes
 *     from a declared natural key instead.
 *
 * `applyResidencyRows` MUST run inside a caller-owned transaction so any failure rolls
 * the whole batch back. Foreign keys stay ON: a child row that arrives before its
 * parent TABLE fails the transaction and self-heals when the parent lands on a later
 * tick. The one FK that never self-heals is `agents` (not in the residency set, lazily
 * registered per DB) — every agent-referencing row therefore ensures a placeholder
 * agent row first, mirroring the local `registerAgent`-before-write path so member
 * knowledge is preserved rather than dropped.
 */
import { epochSeconds } from '@myco/constants.js';
import type { Database } from '@myco/db/client.js';
import { GROVE_PROJECT_SCOPED_TABLES } from '@myco/db/schema-ddl.js';
import { residencyDecodeRow } from '@myco/db/queries/residency-wire.js';
import type { Logger } from '@myco/daemon/logger.js';
import { shouldLogOncePerInterval } from '@myco/daemon/log-throttle.js';

/**
 * The canonical FK-topological table order for a residency transition — the SINGLE
 * source of truth the attach send/apply path builds against (`residency-backfill.ts`,
 * `residency-drain.ts`).
 *
 * It is DERIVED from `GROVE_PROJECT_SCOPED_TABLES`, the same constant
 * `residency-drain.ts` `deleteAfterAck` sweeps, because the two lists being separately
 * maintained is exactly how they diverged: the carried set was inherited from team
 * sync (a D1 replica with a narrower purpose) while the delete set grew with the
 * schema, and seventeen tables — `activities` among them — were deleted on attach
 * having never been sent. Deriving one from the other makes "sent" ⊇ "deleted" hold by
 * construction; `tests/meta/residency-coverage.test.ts` is the gate that fails if
 * anything reintroduces a second hand-maintained list.
 *
 * `content_publications` is appended rather than derived: it has no `project_id`, so
 * it is absent from the scoped set and deleted by its own artifact-scoped helper. It
 * comes last because its tenancy resolves through artifact rows that must land first.
 */
export const RESIDENCY_TABLE_ORDER: readonly string[] = [
  ...GROVE_PROJECT_SCOPED_TABLES,
  'content_publications',
];

/**
 * Every table a residency batch may target. A batch naming anything else is
 * member/host version skew (the protocol gate should have refused it). Exported so the
 * ingest handler can 400 an unknown table and tests can assert the matrix covers the
 * allow-list.
 *
 * `team_members` is allowed but never sent — a member running the pre-parity protocol
 * had it in its carried set, and a host inside the compatibility window must recognize
 * it rather than 400 the whole batch. Its rule is `ignore`.
 */
export const RESIDENCY_ALLOWED_TABLES: ReadonlySet<string> = new Set<string>([
  ...RESIDENCY_TABLE_ORDER,
  'team_members',
]);

/**
 * A residency table that cannot ride `team_outbox`, whose contract is a single `id`
 * column used as `row_id`. Two reasons put a table here, and both are structural
 * rather than a preference: it has no `id` at all (its identity is a composite
 * natural key), or it has one that the outbox deliberately does not carry
 * (`entity_mentions`; see the note in `team-outbox.ts`). The drain pages these
 * directly instead, cursored by `key`.
 *
 * `key` must be UNIQUE WITHIN THE PROJECT SCOPE — it is both the page cursor and the
 * sort order, so a non-unique tuple would silently skip or repeat rows at a page
 * boundary. `scope: 'artifact'` marks the one table with no `project_id`, whose rows
 * are reached through the owning artifact instead.
 */
export interface ResidencySidecar {
  table: string;
  key: readonly string[];
  scope: 'project' | 'artifact';
}

/** Every sidecar stream, in send order. Consumed by `residency-backfill.ts` (one
 *  generic pager) and `residency-drain.ts` (one shipping loop) — adding a table here
 *  is the whole change, which is what keeps this from drifting the way the carried
 *  set did. `content_publications` is last: its tenancy resolves through artifact
 *  rows that must land first. */
export const RESIDENCY_SIDECARS: readonly ResidencySidecar[] = [
  { table: 'entity_mentions', key: ['entity_id', 'note_id', 'note_type', 'agent_id'], scope: 'project' },
  { table: 'agent_state', key: ['agent_id', 'key'], scope: 'project' },
  { table: 'canopy_entries', key: ['path'], scope: 'project' },
  { table: 'canopy_maps', key: ['machine_id'], scope: 'project' },
  { table: 'session_myco_tool_calls', key: ['session_id', 'tool_name', 'op'], scope: 'project' },
  { table: 'session_tombstones', key: ['session_id'], scope: 'project' },
  { table: 'content_publications', key: ['artifact_kind', 'artifact_id'], scope: 'artifact' },
];

const SIDECAR_TABLE_SET: ReadonlySet<string> = new Set(RESIDENCY_SIDECARS.map((s) => s.table));

/** The residency tables that DO ride `team_outbox` — the carried set minus the
 *  sidecars. `residency-backfill.ts` enqueues exactly these. */
export const RESIDENCY_OUTBOX_TABLES: readonly string[] =
  RESIDENCY_TABLE_ORDER.filter((t) => !SIDECAR_TABLE_SET.has(t));

/**
 * SQL selecting the artifact ids that belong to a project across the
 * publishable artifact tables — `content_publications` carries no
 * `project_id`, so project scope comes from the owning artifact row. The
 * SINGLE copy both directions embed (`residency-backfill.ts` paging +
 * delete-after-ack, `residency-pull.ts` detach enumeration); a third
 * publishable artifact kind is one UNION arm here, not a two-file hunt.
 * Binds the project id TWICE — once per arm.
 */
export const PROJECT_ARTIFACT_IDS_SQL = `
  SELECT id FROM skill_records WHERE project_id = ?
  UNION
  SELECT id FROM okf_pages WHERE project_id = ?`;

// ---------------------------------------------------------------------------
// Apply-rule matrix (NORMATIVE) — one rule per allow-listed table.
// ---------------------------------------------------------------------------

/**
 * Replace the existing row only when the incoming one is newer by `timestamp`
 * (falling back to `fallbackTimestamp` when the primary is NULL, so a row that
 * never set it still orders by a stable time rather than making every conflict a
 * silent no-op). `tiebreak` breaks an exact-timestamp tie (skill generation).
 * Older-or-equal incoming → skipped, counted as applied.
 */
interface IfNewerRule {
  kind: 'if-newer';
  timestamp: string;
  fallbackTimestamp?: string;
  tiebreak?: string;
}

/** if-newer keyed by a logical identity tuple rather than the PK — `digest_extracts`
 *  is unique on `(project_id, agent_id, tier)`, so a member row with a different id
 *  but the same identity updates the existing row in place. */
interface IdentityRule {
  kind: 'identity';
  identity: string[];
  timestamp: string;
}

/** Append-only: a de-duping `INSERT OR IGNORE` on the PK. Replays are no-ops. */
interface InsertOnlyRule {
  kind: 'insert-only';
}

/**
 * Per-field merge for a table with no `updated_at` that mutates post-insert.
 * `prefer` columns take a non-null incoming value (COALESCE), `max` columns take
 * the NULL-safe maximum (monotonic counters + `ended_at`), `status` never regresses
 * a terminal value to an in-flight one, and every other column is insert-only
 * (kept as-is on conflict).
 */
interface FieldMergeRule {
  kind: 'field-merge';
  prefer: string[];
  max: string[];
}

/** `content_publications`: upsert on `(artifact_kind, artifact_id)`, keeping the
 *  MAX `published_generation` so a teammate's later publish never regresses. */
interface PublicationsRule {
  kind: 'publications';
}

/** `entity_mentions`: `INSERT OR IGNORE` on the four-column UNIQUE key; a row whose
 *  `entity_id` FK is absent THROWS (retryable rollback) rather than being dropped. */
interface EntityMentionsRule {
  kind: 'entity-mentions';
}

/**
 * The row's `id` is an `INTEGER PRIMARY KEY AUTOINCREMENT` — a counter private to the
 * machine that wrote it. Two members' rows both claim id 42 while being unrelated, so
 * the id is DROPPED on apply and the receiver's own AUTOINCREMENT assigns a fresh one.
 *
 * That leaves nothing to make a replay idempotent, so identity becomes EVERY OTHER
 * SHIPPED COLUMN: a row is a duplicate only when it is byte-identical to one already
 * present. Two byte-identical rows carry no distinguishing INFORMATION — merging
 * them loses no content — but they can be genuinely distinct EVENTS (capture writes,
 * say, twelve identical `git status` tool calls in one batch), so this does UNDERCOUNT:
 * the host keeps one row where the member had twelve, and a denormalized counter like
 * `prompt_batches.activity_count` can then read higher than the surviving rows.
 * Measured ~0.6% of `activities` on a real vault. Accepted as a bounded, convergent
 * residual — the alternative (a per-row source ordinal to preserve multiplicity) is a
 * schema change disproportionate to a count that carries no information — but stated
 * honestly here rather than claimed away: this is lossless of CONTENT, not of COUNT.
 *
 * Hand-picked identifying tuples were tried first and failed twice, the second time
 * in production data. `activities` keyed on (scope, parents, `tool_name`, `timestamp`)
 * looks identifying and is not: capture leaves `content_hash` NULL, timestamps have
 * one-second resolution, and bursts within one second are its ordinary output — so
 * eight `Read` calls in one batch arrived at the host as three rows. Any tuple
 * narrower than the row is a guess about which differences matter, and this data has
 * no column that reliably carries them.
 *
 * The comparison is NULL-safe (`IS`, not `=`), because most of these columns are
 * nullable and `= NULL` never matches — a `=` probe would re-insert on every replay.
 * The probe leads with the indexed scope column, so it stays a range scan and then
 * filters, and it runs once per row during a one-time transition.
 *
 * `selfRef`, where present, names a column FK-ing this same table by the dropped id.
 * Rows are emitted parent-first and the parent's freshly-assigned id is substituted;
 * a parent outside the batch cannot be resolved and the link is nulled. See
 * `applyLocalRowid`.
 */
interface LocalRowidRule {
  kind: 'local-rowid';
  selfRef?: string;
}

/**
 * Upsert on a composite natural PRIMARY KEY rather than `id`. Used by the tables whose
 * identity IS their key tuple (`canopy_entries` on `(project_id, path)`,
 * `agent_state` on `(agent_id, project_id, key)`, …) — globally stable, so unlike
 * {@link LocalRowidRule} these need no id rewriting. `timestamp`, when given, guards
 * the update so a stale batch never regresses a fresher row; without it the incoming
 * row wins (correct where the key already pins the writer, e.g. `canopy_maps` keyed by
 * `machine_id`). `max` columns take the NULL-safe maximum instead of being replaced.
 */
interface CompositeKeyRule {
  kind: 'composite-key';
  key: string[];
  timestamp?: string;
  max?: string[];
  /** The WHERE clause of a PARTIAL unique index, when the key is enforced by one.
   *  SQLite matches an upsert's conflict target against the index predicate too, so
   *  omitting it raises "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
   *  constraint" — the project-scoped uniqueness indexes are all partial
   *  (`WHERE project_id IS NOT NULL`, paired with a legacy `IS NULL` twin). */
  keyPredicate?: string;
}

/** A recognized table the residency drain never actually sends (`team_members` is
 *  machine-scoped, has no `project_id`, and is excluded member-side). Allow-listed so
 *  a member inside the compatibility window that still sends it is not refused, but
 *  applied as a no-op: writing a machine's roster row into the host would corrupt the
 *  host's own roster. */
interface IgnoreRule {
  kind: 'ignore';
}

type ApplyRule =
  | IfNewerRule
  | IdentityRule
  | InsertOnlyRule
  | FieldMergeRule
  | PublicationsRule
  | EntityMentionsRule
  | LocalRowidRule
  | CompositeKeyRule
  | IgnoreRule;

/**
 * The normative per-table apply rule. Keyed exactly to {@link RESIDENCY_ALLOWED_TABLES};
 * a table present in the allow-list but absent here is a programming error surfaced
 * at apply time. Exported so tests can assert the matrix covers the allow-list.
 */
export const RESIDENCY_APPLY_RULES: Readonly<Record<string, ApplyRule>> = {
  // -- if-newer via updated_at (fallback created_at for the nullable ones) --
  spores: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  plans: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  artifacts: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  skill_candidates: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  skill_records: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at', tiebreak: 'generation' },
  okf_generations: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  okf_pages: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'created_at' },
  knowledge_release_state: { kind: 'if-newer', timestamp: 'updated_at', fallbackTimestamp: 'checked_at' },
  // -- if-newer via a surrogate timestamp --
  entities: { kind: 'if-newer', timestamp: 'last_seen' },
  digest_extracts: { kind: 'identity', identity: ['project_id', 'agent_id', 'tier'], timestamp: 'generated_at' },
  // -- insert-only (append-only logs) --
  resolution_events: { kind: 'insert-only' },
  skill_lineage: { kind: 'insert-only' },
  skill_usage: { kind: 'insert-only' },
  okf_page_revisions: { kind: 'insert-only' },
  graph_edges: { kind: 'insert-only' },
  // -- field-level merge (no updated_at; mutate post-insert) --
  sessions: {
    kind: 'field-merge',
    prefer: ['title', 'summary', 'content_hash', 'parent_session_id', 'parent_session_reason', 'transcript_path'],
    max: ['prompt_count', 'tool_count', 'ended_at', 'processed'],
  },
  prompt_batches: {
    kind: 'field-merge',
    prefer: ['user_prompt', 'response_summary', 'classification', 'content_hash', 'parent_prompt_batch_id', 'thread_id', 'thread_label'],
    max: ['activity_count', 'ended_at', 'processed'],
  },
  // -- sidecars --
  content_publications: { kind: 'publications' },
  entity_mentions: { kind: 'entity-mentions' },
  // -- globally-unique TEXT keys, mutate post-insert --
  agent_runs: {
    kind: 'field-merge',
    prefer: ['task', 'instruction', 'harness', 'provider', 'model', 'session_ref', 'resume_status', 'resume_mode', 'checkpoints', 'usage_data', 'cost_source', 'cost_data', 'actions_taken', 'error', 'reasoning_level', 'execution_overrides', 'run_context'],
    max: ['completed_at', 'resumed_at', 'tokens_used', 'resume_attempts', 'cost_usd', 'actual_cost_usd', 'estimated_cost_usd'],
  },
  content_claims: {
    kind: 'field-merge',
    prefer: ['state', 'claimed_by'],
    max: ['generation', 'expires_at', 'released_at', 'published_at'],
  },
  // -- globally-unique TEXT keys, immutable once written --
  attachments: { kind: 'insert-only' },
  // A notification's `status` mutates unread -> read LOCALLY. insert-only rather than
  // a merge so a re-pushed stale copy can never resurrect a notification the
  // receiver already dismissed.
  notifications: { kind: 'insert-only' },
  // `id` is TEXT but not the PRIMARY KEY — uniqueness is the composite index
  // `(project_id, id)`, which is the conflict target.
  cortex_instructions: { kind: 'composite-key', key: ['project_id', 'id'], keyPredicate: 'project_id IS NOT NULL', timestamp: 'generated_at' },
  // -- composite natural keys (globally stable; no id to rewrite) --
  agent_state: { kind: 'composite-key', key: ['agent_id', 'project_id', 'key'], timestamp: 'updated_at' },
  canopy_entries: { kind: 'composite-key', key: ['project_id', 'path'], timestamp: 'mechanical_updated_at' },
  canopy_maps: { kind: 'composite-key', key: ['project_id', 'machine_id'], timestamp: 'generated_at' },
  // `count` is a monotonic tally, so a replayed page must not reset it downward.
  session_myco_tool_calls: { kind: 'composite-key', key: ['session_id', 'tool_name', 'op'], max: ['count', 'computed_at'] },
  session_tombstones: { kind: 'composite-key', key: ['session_id'] },
  // -- local rowid ids: dropped on apply, identity from a natural key --
  // -- local rowid ids: dropped on apply, identity is the whole row --
  activities: { kind: 'local-rowid' },
  knowledge_git_provenance: { kind: 'local-rowid' },
  agent_turns: { kind: 'local-rowid' },
  agent_reports: { kind: 'local-rowid' },
  agent_run_write_intents: { kind: 'local-rowid' },
  agent_run_events: { kind: 'local-rowid' },
  log_entries: { kind: 'local-rowid' },
  digest_extract_revisions: { kind: 'local-rowid', selfRef: 'parent_revision_id' },
  // -- recognized-but-never-sent --
  team_members: { kind: 'ignore' },
};

/** Tables whose rows carry an `agent_id` that FKs `agents` (not in the residency
 *  set) — every one ensures a placeholder agent row before its rows are applied. */
const AGENT_REFERENCING_TABLES: ReadonlySet<string> = new Set<string>([
  'spores', 'entities', 'graph_edges', 'resolution_events', 'digest_extracts',
  'skill_candidates', 'skill_records', 'entity_mentions',
  'agent_runs', 'agent_reports', 'agent_turns', 'agent_state',
]);

/**
 * Ranked session/batch status: a terminal value (completed/failed) outranks an
 * in-flight one (active/processing), so a merge never regresses a finished row to
 * active. An unknown status ranks lowest. Kept as SQL so the whole merge is one
 * statement.
 */
function statusRankSql(col: string): string {
  return `(CASE ${col} `
    + `WHEN 'completed' THEN 3 WHEN 'failed' THEN 3 `
    + `WHEN 'processing' THEN 2 WHEN 'active' THEN 1 ELSE 0 END)`;
}

/** NULL-safe max: prefer whichever side is non-null, else the larger. SQLite's
 *  scalar `max()` returns NULL if ANY argument is NULL, which would drop a live
 *  `ended_at` against a still-null one — this expression never does. */
function nullSafeMaxSql(col: string): string {
  return `CASE WHEN excluded.${col} IS NULL THEN ${col} `
    + `WHEN ${col} IS NULL THEN excluded.${col} `
    + `WHEN excluded.${col} > ${col} THEN excluded.${col} ELSE ${col} END`;
}

/** The freshness comparison for an if-newer rule (incoming strictly newer). */
function ifNewerConditionSql(rule: IfNewerRule): string {
  const inc = rule.fallbackTimestamp
    ? `COALESCE(excluded.${rule.timestamp}, excluded.${rule.fallbackTimestamp})`
    : `excluded.${rule.timestamp}`;
  const cur = rule.fallbackTimestamp
    ? `COALESCE(${rule.timestamp}, ${rule.fallbackTimestamp})`
    : rule.timestamp;
  const primary = `${inc} > ${cur}`;
  if (!rule.tiebreak) return primary;
  return `(${primary}) OR (${inc} = ${cur} AND excluded.${rule.tiebreak} > ${rule.tiebreak})`;
}

// ---------------------------------------------------------------------------
// Column resolution + generic row inserts
// ---------------------------------------------------------------------------

const columnCache = new Map<string, Set<string>>();

/** The real column set of a table (cached per process). A member row's keys are
 *  intersected with this so a stray/renamed key never reaches the SQL. */
function tableColumns(db: Database, table: string): Set<string> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
  );
  columnCache.set(table, cols);
  return cols;
}

/** Reset the per-process column cache. Tests that recreate the schema between
 *  cases call this so a stale column set never leaks across DBs. */
export function resetResidencyColumnCache(): void {
  columnCache.clear();
}

/** The row's keys that are real columns of `table`, in a stable order. */
function insertableColumns(row: Record<string, unknown>, columns: Set<string>): string[] {
  return Object.keys(row).filter((k) => columns.has(k));
}

// ---------------------------------------------------------------------------
// Placeholder agents (the un-shipped-FK closer)
// ---------------------------------------------------------------------------

/**
 * Ensure a placeholder `agents` row exists for every `agent_id` the batch
 * references, so the FK is satisfiable. `INSERT OR IGNORE` never overwrites a real
 * agent the host already has (its own intelligence run, or an earlier ensure); a
 * later real `registerAgent` upserts over the placeholder (its `ON CONFLICT DO
 * UPDATE` overwrites name/source/enabled/config). Mirrors the local write path,
 * where `registerAgent` runs before any agent-referencing write.
 *
 * The placeholder is a FK + attribution anchor, never a runnable agent, so it is
 * `enabled = 0` and carries the `hosted-residency` source sentinel: nothing
 * enumerates the table to RUN agents (execution is loader-driven from task YAML),
 * and the loader's seed check is `source = 'built-in'`-filtered, so a placeholder
 * neither runs nor blocks registering the real agent — that registration upgrades
 * this row in place.
 */
function ensureReferencedAgents(db: Database, rows: Record<string, unknown>[], now: number): void {
  const ids = new Set<string>();
  for (const row of rows) {
    const agentId = row.agent_id;
    if (typeof agentId === 'string' && agentId) ids.add(agentId);
  }
  if (ids.size === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
     VALUES (?, ?, 'hosted-residency', 0, ?)`,
  );
  for (const id of ids) stmt.run(id, id, now);
}

// ---------------------------------------------------------------------------
// Per-kind apply
// ---------------------------------------------------------------------------

/** Order rows so any row whose self-referential parent is ALSO in the batch comes
 *  after its parent (`prompt_batches.parent_prompt_batch_id`), so a forward
 *  reference never fails the transaction. A reference to a parent NOT in the batch
 *  (already in the DB, or genuinely absent) is left in place — present-in-DB
 *  satisfies the FK, absent fails and self-heals on retry. Stable; a cycle (never
 *  produced by capture) falls through in original order. */
function topoSortBySelfRef(
  rows: Record<string, unknown>[],
  idKey: string,
  parentKey: string,
): Record<string, unknown>[] {
  const idsInBatch = new Set(rows.map((r) => r[idKey]).filter((v) => v != null));
  const emitted = new Set<unknown>();
  const result: Record<string, unknown>[] = [];
  let remaining = rows;
  while (remaining.length > 0) {
    const next: Record<string, unknown>[] = [];
    let progressed = false;
    for (const row of remaining) {
      const parent = row[parentKey];
      if (parent == null || !idsInBatch.has(parent) || emitted.has(parent)) {
        result.push(row);
        emitted.add(row[idKey]);
        progressed = true;
      } else {
        next.push(row);
      }
    }
    if (!progressed) { result.push(...next); break; }
    remaining = next;
  }
  return result;
}

/** Build an `INSERT [OR IGNORE]` for one row over its insertable columns. */
function insertRow(
  db: Database,
  table: string,
  row: Record<string, unknown>,
  columns: string[],
  orIgnore: boolean,
): void {
  const placeholders = columns.map(() => '?').join(', ');
  db.prepare(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
  ).run(...columns.map((c) => row[c] as never));
}

/** if-newer / field-merge insert with an ON CONFLICT(id) DO UPDATE clause. */
function upsertRow(
  db: Database,
  table: string,
  row: Record<string, unknown>,
  columns: string[],
  setClause: string,
  whereClause: string | null,
): void {
  const placeholders = columns.map(() => '?').join(', ');
  const where = whereClause ? ` WHERE ${whereClause}` : '';
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`
    + ` ON CONFLICT(id) DO UPDATE SET ${setClause}${where}`,
  ).run(...columns.map((c) => row[c] as never));
}

/** if-newer: whole-row replace on conflict, guarded by the freshness condition.
 *  Rows are receiver-stamped (`received_at`) and their claimed ordering
 *  timestamps clamped before the conflict decision. */
function applyIfNewer(db: Database, table: string, rows: Record<string, unknown>[], rule: IfNewerRule, logger?: Logger): void {
  const columns = tableColumns(db, table);
  const where = ifNewerConditionSql(rule);
  const now = epochSeconds();
  for (const raw of rows) {
    const row = stampAndClampRow(raw, table, rule.timestamp, rule.fallbackTimestamp, columns, now, logger);
    const cols = insertableColumns(row, columns);
    const setClause = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
    if (!setClause) { insertRow(db, table, row, cols, true); continue; }
    upsertRow(db, table, row, cols, setClause, where);
  }
}

/** field-merge: per-field COALESCE / NULL-safe-max / status-rank on conflict. */
function applyFieldMerge(db: Database, table: string, rows: Record<string, unknown>[], rule: FieldMergeRule): void {
  const columns = tableColumns(db, table);
  const preferSet = new Set(rule.prefer);
  const maxSet = new Set(rule.max);
  const ordered = table === 'prompt_batches'
    ? topoSortBySelfRef(rows, 'id', 'parent_prompt_batch_id')
    : rows;
  for (const row of ordered) {
    const cols = insertableColumns(row, columns);
    const setParts: string[] = [];
    for (const c of cols) {
      if (c === 'id') continue;
      if (preferSet.has(c)) setParts.push(`${c} = COALESCE(excluded.${c}, ${c})`);
      else if (maxSet.has(c)) setParts.push(`${c} = ${nullSafeMaxSql(c)}`);
      else if (c === 'status') setParts.push(`status = CASE WHEN ${statusRankSql('excluded.status')} > ${statusRankSql('status')} THEN excluded.status ELSE status END`);
      // any other column is insert-only: kept as-is on conflict (absent from SET).
    }
    if (setParts.length === 0) { insertRow(db, table, row, cols, true); continue; }
    upsertRow(db, table, row, cols, setParts.join(', '), null);
  }
}

/** identity upsert (`digest_extracts`): resolve by identity tuple, replace when
 *  the incoming row is newer by `timestamp`, keeping the existing PK. */
function applyIdentity(db: Database, table: string, rows: Record<string, unknown>[], rule: IdentityRule, logger?: Logger): void {
  const columns = tableColumns(db, table);
  const mutable = [...columns].filter((c) => c !== 'id' && !rule.identity.includes(c));
  const now = epochSeconds();
  for (const raw of rows) {
    const row = stampAndClampRow(raw, table, rule.timestamp, undefined, columns, now, logger);
    const whereParts: string[] = [];
    const whereParams: unknown[] = [];
    for (const key of rule.identity) {
      if (row[key] == null) { whereParts.push(`${key} IS NULL`); }
      else { whereParts.push(`${key} = ?`); whereParams.push(row[key]); }
    }
    const existing = db.prepare(
      `SELECT id, ${rule.timestamp} AS ts FROM ${table} WHERE ${whereParts.join(' AND ')}`,
    ).get(...(whereParams as never[])) as { id: string; ts: number } | undefined;

    if (!existing) {
      insertRow(db, table, row, insertableColumns(row, columns), false);
      continue;
    }
    const incomingTs = row[rule.timestamp];
    if (typeof incomingTs === 'number' && incomingTs > existing.ts) {
      const setCols = mutable.filter((c) => c in row);
      if (setCols.length > 0) {
        db.prepare(
          `UPDATE ${table} SET ${setCols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        ).run(...setCols.map((c) => row[c] as never), existing.id);
      }
    }
    // else: existing is newer-or-equal — skip, counted as applied.
  }
}

/** content_publications: MAX-generation upsert on the composite PK. */
function applyPublications(db: Database, rows: Record<string, unknown>[]): void {
  const columns = tableColumns(db, 'content_publications');
  for (const row of rows) {
    const cols = insertableColumns(row, columns);
    const placeholders = cols.map(() => '?').join(', ');
    // Adopt the newer publish's metadata only when its generation is strictly
    // higher; otherwise keep existing and only raise the generation to the max.
    const setParts = cols
      .filter((c) => c !== 'artifact_kind' && c !== 'artifact_id')
      .map((c) => c === 'published_generation'
        ? `published_generation = MAX(excluded.published_generation, content_publications.published_generation)`
        : `${c} = CASE WHEN excluded.published_generation > content_publications.published_generation THEN excluded.${c} ELSE content_publications.${c} END`);
    db.prepare(
      `INSERT INTO content_publications (${cols.join(', ')}) VALUES (${placeholders})`
      + ` ON CONFLICT(artifact_kind, artifact_id) DO UPDATE SET ${setParts.join(', ')}`,
    ).run(...cols.map((c) => row[c] as never));
  }
}

/**
 * entity_mentions: dedup on the four-column UNIQUE key. The row FKs `entities(id)`
 * and `agents(id)`; agents are ensured before this runs (agent-referencing table),
 * so the only FK that can miss is `entities`. An absent entity THROWS — rolling the
 * whole batch back to a retryable failure — rather than being silently dropped:
 * entities always precede mentions in the send order, so it self-heals on the next
 * tick, and a genuinely-orphaned mention surfaces loudly instead of being acked and
 * lost. `INSERT OR IGNORE` dedups an already-present mention — the idempotent replay
 * path — but never swallows the FK violation.
 */
function applyEntityMentions(db: Database, rows: Record<string, unknown>[], scope: ResidencyApplyScope): void {
  const columns = tableColumns(db, 'entity_mentions');
  const entityStmt = db.prepare('SELECT project_id FROM entities WHERE id = ?');
  for (const row of rows) {
    const entity = entityStmt.get(row.entity_id as never) as { project_id: string | null } | undefined;
    if (!entity) {
      throw new Error(`entity_mentions references an absent entity ${String(row.entity_id)}`);
    }
    // The mention's own project_id is validated by the generic scope check;
    // the OWNING ENTITY must also live in the declared project — otherwise a
    // scoped batch could hang a mention off another project's entity.
    if (entity.project_id !== scope.expectedProjectId) {
      throw new ResidencyTenancyError(
        'entity_mentions',
        `entity ${String(row.entity_id)} belongs to project ${String(entity.project_id ?? 'NULL')}, batch is scoped to ${scope.expectedProjectId}`,
      );
    }
    insertRow(db, 'entity_mentions', row, insertableColumns(row, columns), true);
  }
}

/**
 * composite-key: upsert on a natural PRIMARY KEY tuple. Unlike the id-keyed rules the
 * conflict target is spelled out, so this serves the tables whose identity IS their
 * key (`canopy_entries`, `agent_state`, …) including the WITHOUT ROWID ones.
 *
 * With a `timestamp` the update is guarded by strict freshness, so a stale replay is
 * skipped rather than clobbering a newer row; without one the incoming row wins,
 * which is correct only where the key already pins the writer. `max` columns take the
 * NULL-safe maximum so a monotonic tally never regresses.
 */
function applyCompositeKey(db: Database, table: string, rows: Record<string, unknown>[], rule: CompositeKeyRule, logger?: Logger): void {
  const columns = tableColumns(db, table);
  const keySet = new Set(rule.key);
  const maxSet = new Set(rule.max ?? []);
  const now = epochSeconds();
  const where = rule.timestamp ? ` WHERE excluded.${rule.timestamp} > ${table}.${rule.timestamp}` : '';
  for (const raw of rows) {
    const row = rule.timestamp
      ? stampAndClampRow(raw, table, rule.timestamp, undefined, columns, now, logger)
      : raw;
    const cols = insertableColumns(row, columns);
    const setParts = cols
      .filter((c) => !keySet.has(c))
      .map((c) => (maxSet.has(c)
        ? `${c} = ${nullSafeMaxSql(c)}`
        : `${c} = excluded.${c}`));
    if (setParts.length === 0) { insertRow(db, table, row, cols, true); continue; }
    db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      + ` ON CONFLICT(${rule.key.join(', ')})${rule.keyPredicate ? ` WHERE ${rule.keyPredicate}` : ''}`
      + ` DO UPDATE SET ${setParts.join(', ')}${where}`,
    ).run(...cols.map((c) => row[c] as never));
  }
}

/**
 * local-rowid: insert without the sender's `id`, letting the receiver's AUTOINCREMENT
 * assign one, and dedupe on the declared natural key so a replay is a no-op.
 *
 * The dedupe probe uses `IS` rather than `=` for NULL-safety — several of these keys
 * include nullable columns (`activities.content_hash`, `agent_run_events.tool_name`),
 * and `= NULL` is never true, so a `=` probe would re-insert those rows on every
 * replay. The probe and the insert both run inside the caller's transaction, so no
 * concurrent writer can land between them.
 *
 * `selfRef` handles a column FK-ing this same table by the id just dropped: rows are
 * ordered parent-first and each parent's freshly-assigned id is substituted for the
 * sender's. A parent outside this batch has no resolvable id and the link is nulled
 * — a bounded, deliberate residual, since a page carries a whole project's revisions
 * for one (agent, tier) far more often than it splits one.
 */
function applyLocalRowid(db: Database, table: string, rows: Record<string, unknown>[], rule: LocalRowidRule): void {
  const columns = tableColumns(db, table);
  const ordered = rule.selfRef ? topoSortBySelfRef(rows, 'id', rule.selfRef) : rows;
  // Sender id -> receiver id, for resolving in-batch self references.
  const remapped = new Map<unknown, number>();

  for (const raw of ordered) {
    const row: Record<string, unknown> = { ...raw };
    const senderId = row.id;
    delete row.id;
    if (rule.selfRef) {
      const parent = raw[rule.selfRef];
      row[rule.selfRef] = parent == null ? null : (remapped.get(parent) ?? null);
    }

    const cols = insertableColumns(row, columns).filter((c) => c !== 'id');
    // `project_id` first so the probe opens on the scope index; the rest narrow
    // it to a byte-identical row. The self-reference is INCLUDED using its
    // remapped receiver value (set above): stored rows carry receiver-side
    // parent ids, so probing the remapped value keeps two revisions that differ
    // only in lineage apart, while a replay — parent-first ordered — re-resolves
    // the same receiver parent and still matches its prior insert.
    const probeCols = cols
      .sort((a, b) => Number(b === 'project_id') - Number(a === 'project_id'));
    const probeSql = `SELECT id FROM ${table} WHERE ${probeCols.map((c) => `${c} IS ?`).join(' AND ')}`;
    const params = probeCols.map((c) => row[c] as never);

    const existing = db.prepare(probeSql).get(...params) as { id: number } | undefined;
    if (existing) {
      if (senderId != null) remapped.set(senderId, existing.id);
      continue;
    }
    insertRow(db, table, row, cols, false);
    // Only a self-referencing table needs to learn the id it was just assigned;
    // re-probing unconditionally would double the query count on the high-volume
    // append tables (`log_entries`, `agent_run_events`) for a map nobody reads.
    if (rule.selfRef && senderId != null) {
      const assigned = db.prepare(`${probeSql} ORDER BY id DESC LIMIT 1`)
        .get(...params) as { id: number } | undefined;
      if (assigned) remapped.set(senderId, assigned.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Batch apply (one transaction)
// ---------------------------------------------------------------------------

export interface ResidencyApplyResult {
  /** Rows the batch handled — written, deduped, or skipped-as-stale (if-newer).
   *  A batch that fails any row throws (rollback) instead of returning a count. */
  applied: number;
}

/**
 * The tenancy scope every apply MUST declare — a required argument, not a
 * default, so a new call site decides rather than inherits (the same rule the
 * write-admission lease applies to its evidence argument). Every applied row
 * must belong to `expectedProjectId`; a row naming another project (or none)
 * throws {@link ResidencyTenancyError} and rolls the batch back.
 *
 * SCOPE OF THE GUARANTEE: this is batch-internal consistency, not
 * authorization. On the host route the expected project comes from the
 * member-supplied request header, so under v1 flat trust a bearer-holding
 * member can still declare any hosted project — cross-member isolation is the
 * authenticated-machine-identity workstream (post-v1), not this check.
 */
export interface ResidencyApplyScope {
  expectedProjectId: string;
}

/**
 * A batch violated the declared tenancy scope. Distinct from a transient apply
 * failure: retrying the identical batch can never succeed, so the ingest route
 * maps this to a refusal (4xx), not a retryable error.
 */
export class ResidencyTenancyError extends Error {
  constructor(table: string, detail: string) {
    super(`residency batch rejected for ${table}: ${detail}`);
    this.name = 'ResidencyTenancyError';
  }
}

/**
 * Claimed ordering timestamps are clamped to the receiver's own clock (plus a
 * skew allowance) before they decide a conflict. Without this, one row carrying
 * a far-future `updated_at` wins every future conflict PERMANENTLY — the
 * receiver has no way to distinguish a fast clock from a forged one, but it
 * never has to accept a claim from further in the future than clocks drift.
 *
 * Stated residuals, deliberate: (1) the STORED side is never clamped — a row
 * already holding a far-future timestamp (written locally, or before this
 * shipped) still pins until something rewrites it; the clamp prevents NEW pins
 * arriving over the wire, it does not repair history. (2) a clamped row still
 * lands at `now`, so it wins the CURRENT conflict against honestly-older rows —
 * the property delivered is "cannot pin the future", not "cannot win today".
 * (3) a replayed identical far-future row re-clamps to the replay's own `now`
 * and re-applies — content-identical, so convergent, but the stored ordering
 * timestamp creeps to the latest replay time rather than staying frozen.
 */
const MAX_CLAIMED_TIMESTAMP_SKEW_SECONDS = 24 * 60 * 60;

/** Validate every row of a batch against the declared project scope. */
function assertRowsInScope(
  db: Database,
  table: string,
  rows: Record<string, unknown>[],
  scope: ResidencyApplyScope,
): void {
  const columns = tableColumns(db, table);
  if (columns.has('project_id')) {
    for (const row of rows) {
      if (row.project_id !== scope.expectedProjectId) {
        throw new ResidencyTenancyError(
          table,
          `row ${String(row.id ?? row.note_id ?? '?')} names project ${String(row.project_id ?? 'NULL')}, batch is scoped to ${scope.expectedProjectId}`,
        );
      }
    }
  }
}

/**
 * `content_publications` carries no `project_id`; its tenancy comes from the
 * owning artifact row. Two distinct outcomes, deliberately not conflated:
 * an artifact present under ANOTHER project is a tenancy violation (permanent
 * refusal — retrying the identical batch can never succeed), while an artifact
 * not present AT ALL is a transient ordering miss (a publication page can
 * arrive before its artifact table lands) and throws a plain retryable error,
 * mirroring the entity_mentions absent-FK discipline — never acked-and-lost,
 * never permanently refused for arriving early.
 */
function assertPublicationsInScope(
  db: Database,
  rows: Record<string, unknown>[],
  scope: ResidencyApplyScope,
): void {
  const stmt = db.prepare(
    `SELECT project_id FROM (
       SELECT id, project_id FROM skill_records
       UNION
       SELECT id, project_id FROM okf_pages
     ) WHERE id = ?`,
  );
  for (const row of rows) {
    const owner = stmt.get(row.artifact_id as never) as { project_id: string | null } | undefined;
    if (!owner) {
      throw new Error(`content_publications references an absent artifact ${String(row.artifact_id)}`);
    }
    if (owner.project_id !== scope.expectedProjectId) {
      throw new ResidencyTenancyError(
        'content_publications',
        `artifact ${String(row.artifact_id)} belongs to project ${String(owner.project_id ?? 'NULL')}, batch is scoped to ${scope.expectedProjectId}`,
      );
    }
  }
}

/**
 * Stamp the receiver's clock and clamp the claimed ordering timestamp on a row
 * copy. `received_at` records WHEN this receiver applied the row (forensic
 * bookkeeping, local-only for sync); the clamp keeps a caller-supplied
 * timestamp from ordering beyond the receiver's own notion of now + drift.
 * Only the column that DECIDES the conflict is clamped — the primary
 * timestamp when present, else the fallback the COALESCE would use — so a
 * far-future `created_at` riding alongside a sane `updated_at` is preserved
 * as data rather than silently rewritten. A fired clamp logs (throttled): a
 * silent mutation of synced data must be observable.
 */
function stampAndClampRow(
  row: Record<string, unknown>,
  table: string,
  primaryCol: string,
  fallbackCol: string | undefined,
  columns: Set<string>,
  now: number,
  logger: Logger | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (columns.has('received_at')) out.received_at = now;
  const decidingCol = typeof out[primaryCol] === 'number' ? primaryCol : (fallbackCol ?? primaryCol);
  const claimed = out[decidingCol];
  const ceiling = now + MAX_CLAIMED_TIMESTAMP_SKEW_SECONDS;
  if (typeof claimed === 'number' && claimed > ceiling) {
    out[decidingCol] = now;
    if (shouldLogOncePerInterval(`residency.clamp.${table}`, CLAMP_LOG_INTERVAL_MS, Date.now())) {
      logger?.warn('residency-apply', 'clamped a far-future claimed timestamp to the receiver clock', {
        table, row_id: String(out.id ?? '?'), column: decidingCol, claimed, clamped_to: now,
      });
    }
  }
  return out;
}

/** Throttle for clamp warnings — a whole batch of forged rows logs once. */
const CLAMP_LOG_INTERVAL_MS = 60_000;

/**
 * Apply one table's rows under its rule. MUST run inside a transaction (the caller
 * wraps it) so a throw rolls the whole batch back. Ensures referenced agents first
 * for agent-bearing tables. Every row is applied or the whole batch throws — there
 * is no silent-drop path (an absent FK, including an entity_mentions orphan, rolls
 * back to a retryable failure). `logger` is retained for signature stability (both
 * transition directions call this) even where the apply itself is silent.
 */
export function applyResidencyRows(
  db: Database,
  table: string,
  rows: Record<string, unknown>[],
  scope: ResidencyApplyScope,
  deps: { logger?: Logger } = {},
): ResidencyApplyResult {
  const rule = RESIDENCY_APPLY_RULES[table];
  if (!rule) throw new Error(`no residency apply rule for table ${table}`);
  if (rows.length === 0) return { applied: 0 };

  // Decode the wire codec (base64 BLOB wrappers -> Buffers) ONCE, before any
  // rule reads a row — the single chokepoint that mirrors `residencyEncodeRow`
  // on the send side. Idempotent for rows with no BLOB, so it costs a walk and
  // nothing else on the common path.
  rows = rows.map(residencyDecodeRow);

  // Tenancy admission runs BEFORE any write, for every rule kind that writes:
  // a batch is either entirely inside its declared project or entirely
  // refused. `ignore` skips it (never written); publications validate via the
  // owning artifact (no project_id column of their own).
  if (rule.kind === 'publications') {
    assertPublicationsInScope(db, rows, scope);
  } else if (rule.kind !== 'ignore') {
    assertRowsInScope(db, table, rows, scope);
  }

  if (AGENT_REFERENCING_TABLES.has(table)) {
    ensureReferencedAgents(db, rows, epochSeconds());
  }

  switch (rule.kind) {
    case 'if-newer':
      applyIfNewer(db, table, rows, rule, deps.logger);
      break;
    case 'identity':
      applyIdentity(db, table, rows, rule, deps.logger);
      break;
    case 'insert-only':
      for (const row of rows) insertRow(db, table, row, insertableColumns(row, tableColumns(db, table)), true);
      break;
    case 'field-merge':
      applyFieldMerge(db, table, rows, rule);
      break;
    case 'publications':
      applyPublications(db, rows);
      break;
    case 'entity-mentions':
      applyEntityMentions(db, rows, scope);
      break;
    case 'composite-key':
      applyCompositeKey(db, table, rows, rule, deps.logger);
      break;
    case 'local-rowid':
      applyLocalRowid(db, table, rows, rule);
      break;
    case 'ignore':
      // Recognized but never sent by the drain (team_members is machine-scoped).
      break;
  }
  return { applied: rows.length };
}
