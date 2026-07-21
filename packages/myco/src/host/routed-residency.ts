/**
 * Team Host — the host RECEIVE side of a with-history residency attach (Phase F T2).
 *
 * When a project attaches to a Team Host WITH its local history, the member drains
 * that project's rows to the host, one allow-listed table per request
 * (`host/residency-drain.ts` → `POST /routed-capture/residency-rows`). This module
 * is what the host does with each batch: it applies the rows to its served Grove DB
 * under a NORMATIVE per-table rule matrix, and — on the batch that carries it —
 * adopts the member's real project name onto the hosted registry row.
 *
 * The apply rules exist because the residency set spans three write disciplines a
 * single upsert cannot serve:
 *
 *   - **if-newer** (spores, plans, artifacts, skills, OKF, release state, entities):
 *     a monotonic timestamp orders versions, so a batch that arrives out of date
 *     (a slow member re-pushing after the host already has a fresher copy from
 *     another member) never regresses the host — the older row is skipped, not
 *     written, and still counts as applied.
 *   - **insert-only** (append-only logs: resolution/lineage/usage/revisions/edges):
 *     rows are immutable once written, so a plain de-duping insert is correct and
 *     a replay is a no-op.
 *   - **field-merge** (`sessions`, `prompt_batches`): neither carries an
 *     `updated_at` and both mutate heavily post-insert (title/summary enrichment,
 *     activity counts, status transitions), so a whole-row replace would clobber
 *     one side's enrichment with the other's stub. These merge per field: prefer a
 *     non-null incoming enrichment value, take the max of monotonic counters, and
 *     never regress a terminal status to an in-flight one.
 *
 * Every batch is ONE transaction: it commits whole or rolls back whole, and any
 * failure answers non-200 so the member re-sends the identical batch next tick
 * (at-least-once with host-side idempotency — a double-apply of any batch leaves
 * the identical end state). Foreign keys stay ON: a child row that arrives before
 * its parent TABLE fails the transaction and self-heals when the parent lands on a
 * later tick. The one FK that never self-heals is `agents` (not in the residency
 * set, lazily registered per DB) — every agent-referencing row therefore ensures a
 * placeholder agent row first, mirroring the local `registerAgent`-before-write
 * path so member knowledge is preserved rather than dropped.
 */
import { z } from 'zod';

import { epochSeconds } from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { getDatabase, type Database } from '../db/client.js';
import { REBUILD_TABLES } from '../db/queries/team-outbox.js';
import { shouldLogOncePerInterval } from '../daemon/log-throttle.js';
import type { Logger } from '../daemon/logger.js';
import type { RouteRequest, RouteResponse } from '../daemon/router.js';
import { rowProjectIdFromRequestContext } from '../grove/request-context.js';
import { adoptHostedProjectName } from './hosted-projects.js';

/** Throttle window for repeated host-side ingest warnings (unknown table, apply
 *  failure, skipped absent-FK rows) — a rejecting member re-sends every tick. */
const INGEST_LOG_INTERVAL_MS = 60_000;

/** The two sidecar tables that ride the residency route but are not in
 *  `REBUILD_TABLES` (no `id`/`synced_at` outbox contract). */
const RESIDENCY_SIDECAR_TABLES = ['entity_mentions', 'content_publications'] as const;

/**
 * Every table a residency batch may target: the 18 `REBUILD_TABLES` plus the two
 * sidecars. A batch naming anything else is member/host version skew (the protocol
 * gate should have refused it) and is answered 400. Exported so the completeness
 * of the apply matrix can be asserted against it.
 */
export const RESIDENCY_ALLOWED_TABLES: ReadonlySet<string> = new Set<string>([
  ...REBUILD_TABLES,
  ...RESIDENCY_SIDECAR_TABLES,
]);

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

/** `entity_mentions`: `INSERT OR IGNORE` on the four-column UNIQUE key, skipping
 *  (and logging) any row whose `entity_id`/`agent_id` FK is absent — INSERT OR
 *  IGNORE does NOT swallow an FK violation, so the check is explicit. */
interface EntityMentionsRule {
  kind: 'entity-mentions';
}

/** A recognized table the residency drain never actually sends (`team_members` is
 *  machine-scoped, has no `project_id`, and is excluded member-side). Allow-listed
 *  for parity with `REBUILD_TABLES`, but applied as a no-op: writing a machine's
 *  roster row into the host would corrupt the host's own roster. */
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
  // -- recognized-but-never-sent --
  team_members: { kind: 'ignore' },
};

/** Tables whose rows carry an `agent_id` that FKs `agents` (not in the residency
 *  set) — every one ensures a placeholder agent row before its rows are applied. */
const AGENT_REFERENCING_TABLES: ReadonlySet<string> = new Set<string>([
  'spores', 'entities', 'graph_edges', 'resolution_events', 'digest_extracts',
  'skill_candidates', 'skill_records', 'entity_mentions',
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
 * later real `registerAgent` upserts over the placeholder. Mirrors the local
 * write path, where `registerAgent` runs before any agent-referencing write.
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
     VALUES (?, ?, 'hosted-residency', 1, ?)`,
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

/** if-newer: whole-row replace on conflict, guarded by the freshness condition. */
function applyIfNewer(db: Database, table: string, rows: Record<string, unknown>[], rule: IfNewerRule): void {
  const columns = tableColumns(db, table);
  const where = ifNewerConditionSql(rule);
  for (const row of rows) {
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
function applyIdentity(db: Database, table: string, rows: Record<string, unknown>[], rule: IdentityRule): void {
  const columns = tableColumns(db, table);
  const mutable = [...columns].filter((c) => c !== 'id' && !rule.identity.includes(c));
  for (const row of rows) {
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

/** The result of an entity_mentions apply: which rows were dropped for an absent FK. */
interface EntityMentionsResult {
  skipped: number;
}

/** entity_mentions: dedup on the four-column key, skipping rows whose `entity_id`
 *  or `agent_id` is absent (an FK an OR IGNORE would surface as a hard error). */
function applyEntityMentions(db: Database, rows: Record<string, unknown>[]): EntityMentionsResult {
  const columns = tableColumns(db, 'entity_mentions');
  const entityStmt = db.prepare('SELECT 1 FROM entities WHERE id = ?');
  const agentStmt = db.prepare('SELECT 1 FROM agents WHERE id = ?');
  let skipped = 0;
  for (const row of rows) {
    if (!entityStmt.get(row.entity_id as never) || !agentStmt.get(row.agent_id as never)) {
      skipped += 1;
      continue;
    }
    insertRow(db, 'entity_mentions', row, insertableColumns(row, columns), true);
  }
  return { skipped };
}

// ---------------------------------------------------------------------------
// Batch apply (one transaction)
// ---------------------------------------------------------------------------

export interface ResidencyApplyResult {
  applied: number;
  /** entity_mentions rows dropped for an absent entity/agent FK (0 for other tables). */
  skippedAbsentFk: number;
}

/**
 * Apply one table's rows under its rule. MUST run inside a transaction (the caller
 * wraps it) so a throw rolls the whole batch back. Ensures referenced agents first
 * for agent-bearing tables. `applied` counts every row the batch handled
 * (written, deduped, or skipped-as-stale); absent-FK entity_mention drops are
 * reported separately.
 */
export function applyResidencyRows(
  db: Database,
  table: string,
  rows: Record<string, unknown>[],
  deps: { logger?: Logger } = {},
): ResidencyApplyResult {
  const rule = RESIDENCY_APPLY_RULES[table];
  if (!rule) throw new Error(`no residency apply rule for table ${table}`);
  if (rows.length === 0) return { applied: 0, skippedAbsentFk: 0 };

  if (AGENT_REFERENCING_TABLES.has(table)) {
    ensureReferencedAgents(db, rows, epochSeconds());
  }

  switch (rule.kind) {
    case 'if-newer':
      applyIfNewer(db, table, rows, rule);
      return { applied: rows.length, skippedAbsentFk: 0 };
    case 'identity':
      applyIdentity(db, table, rows, rule);
      return { applied: rows.length, skippedAbsentFk: 0 };
    case 'insert-only':
      for (const row of rows) insertRow(db, table, row, insertableColumns(row, tableColumns(db, table)), true);
      return { applied: rows.length, skippedAbsentFk: 0 };
    case 'field-merge':
      applyFieldMerge(db, table, rows, rule);
      return { applied: rows.length, skippedAbsentFk: 0 };
    case 'publications':
      applyPublications(db, rows);
      return { applied: rows.length, skippedAbsentFk: 0 };
    case 'entity-mentions': {
      const { skipped } = applyEntityMentions(db, rows);
      if (skipped > 0 && shouldLogOncePerInterval('residency.entity_mentions_absent_fk', INGEST_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Skipped entity_mentions rows with an absent entity/agent', {
          skipped,
        });
      }
      return { applied: rows.length - skipped, skippedAbsentFk: skipped };
    }
    case 'ignore':
      // Recognized but never sent by the drain (team_members is machine-scoped).
      return { applied: rows.length, skippedAbsentFk: 0 };
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** The residency-rows push body (matches the frozen T1 wire contract). */
const ResidencyRowsBody = z.object({
  table: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())),
  adoption: z.object({ project_name: z.string() }).optional(),
});

/**
 * Build the `POST /routed-capture/residency-rows` handler. Runs inside the
 * daemon's per-request `withDatabase` boundary (the member's tenancy headers bind
 * the served Grove DB), so `getDatabase()` resolves to the correct Grove. `mycoHome`
 * is injectable for tests; production uses the resolved home for the adoption write.
 */
export function createRoutedResidencyHandler(
  deps: { logger?: Logger; mycoHome?: string } = {},
): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const parsed = ResidencyRowsBody.safeParse(req.body);
    if (!parsed.success) {
      return { status: 400, body: { ok: false, error: 'invalid_body', detail: parsed.error.issues } };
    }
    const { table, rows, adoption } = parsed.data;

    if (!RESIDENCY_ALLOWED_TABLES.has(table)) {
      // A permanently-invalid table means member/host version skew the protocol
      // gate should have caught; log it (throttled — the member retries every
      // tick) and answer a coded 400.
      if (shouldLogOncePerInterval(`residency.unknown_table:${table}`, INGEST_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Residency batch named an unknown table', { table });
      }
      return { status: 400, body: { ok: false, error: 'unknown_table', table } };
    }

    const groveId = req.requestContext?.groveId ?? null;
    const projectId = rowProjectIdFromRequestContext(req.requestContext) ?? null;

    let applied: number;
    try {
      const db = getDatabase();
      const result = db.transaction(() => applyResidencyRows(db, table, rows, { logger: deps.logger }))();
      applied = result.applied;
    } catch (err) {
      // Rolled back whole. A child arriving before its parent table is the
      // designed self-healing case: answer retryable so the member re-sends the
      // identical batch next tick, after the parent lands.
      if (shouldLogOncePerInterval(`residency.apply_failed:${table}`, INGEST_LOG_INTERVAL_MS)) {
        deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Residency batch apply failed — member will retry', {
          table,
          error: (err as Error).message,
        });
      }
      return { status: 409, body: { ok: false, error: 'apply_failed', retryable: true, message: (err as Error).message } };
    }

    // Adoption rides the first batch; best-effort so a cosmetic registry write
    // never blocks the durable rows' ack. Idempotent (no-op once the placeholder
    // name is upgraded), so a replayed first batch does not re-adopt.
    if (adoption?.project_name && groveId && projectId) {
      try {
        adoptHostedProjectName(groveId, projectId, adoption.project_name, deps.mycoHome);
      } catch (err) {
        if (shouldLogOncePerInterval(`residency.adopt_failed:${projectId}`, INGEST_LOG_INTERVAL_MS)) {
          deps.logger?.warn(LOG_KINDS.RESIDENCY_ATTACH_PUSH, 'Hosted project name adoption failed', {
            project_id: projectId,
            error: (err as Error).message,
          });
        }
      }
    }

    return { status: 200, body: { ok: true, applied } };
  };
}
