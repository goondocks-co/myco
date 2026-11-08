import { importEnabledChecks } from './import-policy.js';
/**
 * Spores and their supersession lineage, server-side.
 *
 * Three properties the 1.4 vault encodes and a translation drops silently:
 *
 * **The terminal-session gate.** An intelligence task must not read a spore
 * from a session still in flight — the session's own conclusions are not
 * settled yet. 1.4 expresses this as `sessions.status != 'active'`; here the
 * session facts carry `ended_at`, so a session is terminal once it has one.
 * Callers that are not intelligence tasks leave the gate off and see
 * everything, and a direct `sessionId` lookup always bypasses it.
 *
 * **Supersession lineage reads resolution events alone.** 1.4 also reads
 * `graph_edges` of type `SUPERSEDED_BY`, but that table retires with the
 * semantic graph, and the supersede path writes both inside one transaction
 * (`packages/myco/src/spores/write.ts`) — every edge has a resolution event
 * committed beside it, so the events are the complete record.
 *
 * **A status change and its resolution event are one write.** A status moved
 * without its event leaves a spore superseded by nothing, which no reader can
 * repair; a batch is atomic by contract, so the pair commits or neither does.
 */
import { consolidationSourcesChanged, consolidationSourcesCurrent, staleConsolidationSource, type StaleConsolidationSource } from '../db/spores/consolidation.js';
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { GUARD_ENABLED_AT } from '../db/schema-v101.js';
import { decodeCursor, encodeCursor, inListChunks, MAX_PAGE, type ProjectSet, type ReadScope } from '../read/scope.js';
import { decodeProjectCursor, encodeProjectCursor } from '../read/project-cursor.js';
import { readSporePage, SPORE_COLUMNS, SPORE_READ_COLUMNS, type SporeBrowseFilters, type SporePageKey } from '../db/spores/browse.js';
import { SPORE_DAY_MS, sporeTotal, sporeTotalAndFacets, utcDays, type SporeCountFilters, type SporeFacetCounts } from '../db/spores/counts.js';

export { OBSERVATION_TYPES, type ObservationType } from '@goondocks/myco-shared/member-protocol';

export const SPORE_STATUSES = ['active', 'superseded', 'consolidated', 'obsolete'] as const;
export type SporeStatus = (typeof SPORE_STATUSES)[number];

export const RESOLUTION_ACTIONS = ['supersede', 'consolidate', 'obsolete'] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** The largest spore body any writer accepts, bounding one row against a caller that would grow it without limit. */
export const MAX_SPORE_CONTENT_BYTES = 256 * 1024;

export const DEFAULT_SPORE_LIMIT = 50;
export const MAX_SPORE_LIMIT = 200;

/** How much of a body an inventory listing carries, so a sweep can survey a whole vault without pulling it into a model's context. */
export const SPORE_PREVIEW_CHARS = 200;

/** How many spores one run may read in full, past which the surface answers that the budget is spent; a sweep judges by previews and spends its reads on the clusters it means to resolve. */
export const SPORE_FULL_READ_BUDGET = 12;

/** The largest body one full read carries, so a single spore cannot flood a model's context; a body longer than this arrives cut, and the answer says so. */
export const SPORE_BODY_CHARS = SPORE_PREVIEW_CHARS * 40;

/** A pull request or a commit a write cites in place of a session. A kind without a ref is unrepresentable. */
export interface SporeProvenance {
  kind: 'pr' | 'commit';
  ref: string;
}

export interface SporeInsert {
  channel?: 'import';
  id: string;
  agentId: string;
  sessionId: string | null;
  observationType: string;
  status?: SporeStatus;
  content: string;
  context: string | null;
  importance?: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  /** The principal instance that wrote it: a member id, a run id; null on rows written before the column existed. */
  author: string | null;
  /** What the write cites when it names no session; absent on a write that names one. */
  provenance?: SporeProvenance | null;
  /**
   * The ≈40-token projection injection and search previews render, or null
   * until a run derives one.
   *
   * Optional so a write site that has no line omits it rather than spelling a
   * null; every line is null until an extraction run derives one.
   */
  agentLine?: string | null;
  createdAt: number;
}

export interface SporeRow {
  id: string;
  agentId: string;
  sessionId: string | null;
  observationType: string;
  status: string;
  revision: number;
  content: string;
  context: string | null;
  importance: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  author: string | null;
  provenanceKind: string | null;
  provenanceRef: string | null;
  agentLine: string | null;
  /**
   * Who `author` is: a run, a member or an External Agent grant; null where the row names no author. Served on reads;
   * the row a write answers with omits it.
   */
  authorKind?: 'run' | 'member' | 'imported' | 'grant' | null;
  createdAt: number;
  updatedAt: number | null;
  embedded: number;
}

/**
 * A spore list's structured filters, its page size and the cursor the previous page answered. A time bound is widened to
 * whole UTC days: a start instant to the first instant of its day, `createdTo` to the end of the day before it, unless it
 * is a day's first instant. The page and its total read the same widened window.
 */
export interface ListSporesOptions extends SporeBrowseFilters {
  /** Spores written in the UTC day of this instant (ms) and after. */
  since?: number;
  limit?: number;
  cursor?: string;
}

/**
 * One page of a spore list. `hasMore` says whether another page follows and `cursor` continues after this page's last
 * row. `total` is how many spores the filters admit, read from the maintained counters, and is absent with `counting:
 * 'building'` while existing spores are still being counted. A list narrowed by agent or author, or by
 * `includeActive: false`, carries no total, whatever else it names. `window` is the widened time range the page and its
 * total read, when the list names one.
 */
export interface SporeListPage<T> {
  rows: T[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
  counting?: 'building';
  window?: { from?: number; to?: number };
}

const COLUMNS = SPORE_COLUMNS;
/** A read's columns: the row, and who its author is. */
const READ_COLUMNS = SPORE_READ_COLUMNS;

/**
 * Writes one spore and returns it, or null when the Project already holds a
 * spore under that id, which is left as it is.
 *
 * `RETURNING` rather than a read-back: 1.4 selects the row again after
 * inserting it, which is free against a local file and a second round trip
 * against a Deployment.
 */
export async function insertSpore(db: RelationalStore, scope: ReadScope, row: SporeInsert): Promise<SporeRow | null> {
  return sporeInsert(db, scope, row, true).first<SporeRow>();
}

export type SporeAuthority = { kind: 'grant'; grantId: string } | { kind: 'member' | 'run' };

/** Grant lifecycle sources and replacements must all carry the authenticated grant as author. */
function grantSources(scope: ReadScope, authority: SporeAuthority | undefined, ids: readonly string[]): { sql: string; params: unknown[] } {
  return authority?.kind !== 'grant' ? { sql: '1', params: [] } : {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) requested LEFT JOIN spores owned
      ON owned.project_id = ? AND owned.id = requested.value AND owned.author = ? WHERE owned.id IS NULL)`,
    params: [JSON.stringify(ids), scope.projectId, authority.grantId],
  };
}

/** Every new spore stores only its session citation. */
function sporeInsert(db: RelationalStore, scope: ReadScope, row: SporeInsert, ignoreConflict = false, guard = { sql: '1', params: [] as unknown[] }): PreparedStatement {
  const imported = row.channel === 'import' ? importEnabledChecks().admission : { sql: '1', params: [] };
  return db.prepare(`INSERT INTO spores
      (project_id, id, agent_id, session_id, observation_type, status, content, context,
       importance, file_path, tags, content_hash, properties, author, provenance_kind, provenance_ref, agent_line, created_at, embedded)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0 WHERE ${guard.sql} AND ${imported.sql}
      ${ignoreConflict ? 'ON CONFLICT (project_id, id) DO NOTHING' : ''}
      RETURNING ${COLUMNS}`)
    .bind(scope.projectId, row.id, row.agentId, row.sessionId, row.observationType,
      row.status ?? 'active', row.content, row.context, row.importance ?? 5, row.filePath,
      row.tags, row.contentHash, row.properties, row.author,
      row.provenance?.kind ?? null, row.provenance?.ref ?? null, row.agentLine ?? null, row.createdAt, ...guard.params, ...imported.params);
}

/** Fill absent import provenance only when the original spore and its stored source agree. */
export async function repairImportedSporeSource(db: RelationalStore, scope: ReadScope, row: Pick<SporeInsert, 'id' | 'author' | 'agentId' | 'content' | 'sessionId'> & { createdAt?: number }): Promise<'restored' | 'kept' | 'pending'> {
  if (row.sessionId === null) return 'restored';
  const admitted = importEnabledChecks().admission;
  await db.prepare(`UPDATE spores SET session_id = COALESCE(session_id, ?)
    WHERE project_id = ? AND id = ? AND author = ? AND agent_id = ? AND content = ? AND (? IS NULL OR created_at = ?)
      AND (session_id IS NULL OR session_id = ?)
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = spores.project_id AND s.session_id = ?) AND ${admitted.sql}`)
    .bind(row.sessionId, scope.projectId, row.id, row.author, row.agentId, row.content, row.createdAt ?? null, row.createdAt ?? null, row.sessionId, row.sessionId, ...admitted.params).run();
  const held = await getSpore(db, scope, row.id);
  if (held?.sessionId === row.sessionId) return 'restored';
  if (held !== null && ((held.sessionId !== null && held.sessionId !== row.sessionId)
    || held.author !== row.author || held.agentId !== row.agentId || held.content !== row.content || (row.createdAt !== undefined && held.createdAt !== row.createdAt))) return 'kept';
  return 'pending';
}

export async function getSpore(db: RelationalStore, scope: ReadScope, id: string): Promise<(SporeRow & { sourceCreatedAt: number | null }) | null> {
  return db.prepare(`SELECT ${READ_COLUMNS}, (SELECT COALESCE(s.started_at, s.first_received_at) FROM sessions s
    WHERE s.project_id = spores.project_id AND s.session_id = spores.session_id) AS sourceCreatedAt
    FROM spores WHERE project_id = ? AND id = ?`)
    .bind(scope.projectId, id).first<SporeRow & { sourceCreatedAt: number | null }>();
}

/**
 * The named spores of this Project, in the store's own order. Ids the Project
 * does not hold are absent from the answer rather than an error: a reader
 * hydrating a record kept past a spore is told what is still there.
 */
export async function listSporesByIds(db: RelationalStore, scope: ReadScope, ids: readonly string[]): Promise<SporeRow[]> {
  const wanted = [...new Set(ids)].slice(0, MAX_SPORE_LIMIT);
  const out: SporeRow[] = [];
  // More ids than one statement may bind are read in runs.
  for (const run of inListChunks(wanted)) {
    const { results } = await db
      .prepare(`SELECT ${READ_COLUMNS} FROM spores WHERE project_id = ? AND id IN (${run.map(() => '?').join(', ')})`)
      .bind(scope.projectId, ...run).all<SporeRow>();
    out.push(...results);
  }
  return out;
}

/** The newest active spores of one Project a word match reads. */
const WORD_MATCH_WINDOW = MAX_SPORE_LIMIT;
/** How much of a spore's body a word match reads, beside its agent line. */
const WORD_MATCH_BODY_CHARS = 2_000;

/**
 * The ids of active spores holding the most of these words, among the Project's newest. The index walks one Project's
 * active spores and stops at the window before any is scored, so what the rest of the Deployment holds costs nothing.
 */
export async function activeSporesMatchingAnyWord(db: RelationalStore, scope: ReadScope, words: readonly string[], excludingId: string, limit: number): Promise<string[]> {
  if (words.length === 0) return [];
  const { results } = await db.prepare(`SELECT id, ${words.map(() => '(instr(text, ?) > 0)').join(' + ')} AS score FROM (
      SELECT id, created_at, lower(COALESCE(agent_line, '') || ' ' || substr(content, 1, ?)) AS text FROM spores INDEXED BY idx_spores_status
      WHERE project_id = ? AND status = 'active' AND id <> ? ORDER BY created_at DESC LIMIT ?)
    WHERE score > 0 ORDER BY score DESC, created_at DESC, id LIMIT ?`)
    .bind(...words, WORD_MATCH_BODY_CHARS, scope.projectId, excludingId, WORD_MATCH_WINDOW, limit).all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Whether this author — a run id, a member id or a grant id — wrote at least one spore in this Project. */
export async function sporeAuthoredBy(db: RelationalStore, scope: ReadScope, author: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS one FROM spores WHERE project_id = ? AND author = ? LIMIT 1`).bind(scope.projectId, author).first<{ one: number }>();
  return row !== null;
}

export interface ResolutionEventInsert {
  channel?: 'import';
  id: string;
  agentId: string;
  sporeId: string;
  action: ResolutionAction;
  newSporeId: string | null;
  reason: string | null;
  sessionId: string | null;
  /** The principal instance that resolved it, as `SporeInsert.author`. */
  author: string | null;
  /** As `SporeInsert.provenance`. */
  provenance?: SporeProvenance | null;
  createdAt: number;
}

/** A run's dispatched instructions require revisions unless they predate this Deployment's guard boundary. */
export async function sporeRevisionRequired(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  return await db.prepare(`SELECT 1 FROM agent_runs r JOIN schema_meta m ON m.key = ?
    WHERE r.project_id = ? AND r.id = ? AND r.started_at < CAST(m.value AS INTEGER)`)
    .bind(GUARD_ENABLED_AT, scope.projectId, runId).first() === null;
}

export interface SporeExpectation {
  status?: SporeStatus;
  revision?: number;
}

export interface SporeSource {
  id: string;
  revision?: number;
}

export interface StaleSpore {
  error: 'stale';
  reason: string;
  status: string;
  revision: number;
}

/** Import history admits its expected final state as well as a source that is still active. */
function expectedResolutionStatus(status: SporeStatus, event: ResolutionEventInsert, expect: SporeExpectation): SporeStatus {
  return expect.status ?? (event.channel === 'import' ? status : 'active');
}

/** The status move and its event are adjacent; changes() counts only that move, excluding trigger writes. */
function resolutionStatements(
  db: RelationalStore, scope: ReadScope, status: SporeStatus, event: ResolutionEventInsert,
  now: number, expect: SporeExpectation, authority?: SporeAuthority,
): PreparedStatement[] {
  const owned = grantSources(scope, authority, [event.sporeId, ...(event.newSporeId === null ? [] : [event.newSporeId])]);
  const imported = event.channel === 'import' ? importEnabledChecks().admission : { sql: '1', params: [] };
  return [
    db.prepare(`UPDATE spores SET status = ?, revision = revision + 1, updated_at = ?
      WHERE project_id = ? AND id = ? AND (status = ?${event.channel === 'import' ? " OR status = 'active'" : ''})${expect.revision === undefined ? '' : ' AND revision = ?'}
        AND NOT EXISTS (SELECT 1 FROM resolution_events WHERE project_id = ? AND id = ?) AND ${owned.sql} AND ${imported.sql} RETURNING id`)
      .bind(status, now, scope.projectId, event.sporeId, expectedResolutionStatus(status, event, expect),
        ...(expect.revision === undefined ? [] : [expect.revision]), scope.projectId, event.id, ...owned.params, ...imported.params),
    db.prepare(`INSERT INTO resolution_events
        (project_id, id, agent_id, spore_id, action, new_spore_id, reason, session_id, author, provenance_kind, provenance_ref, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(scope.projectId, event.id, event.agentId, event.sporeId, event.action,
        event.newSporeId, event.reason, event.sessionId, event.author,
        event.provenance?.kind ?? null, event.provenance?.ref ?? null, event.createdAt),
  ];
}

/** Move a spore and record its event atomically; replayed event ids change nothing. */
export async function resolveSpore(
  db: RelationalStore, scope: ReadScope, status: SporeStatus, event: ResolutionEventInsert,
  now: number, expect: SporeExpectation = {}, authority?: SporeAuthority,
): Promise<boolean | 'duplicate' | StaleSpore> {
  const owned = grantSources(scope, authority, [event.sporeId, ...(event.newSporeId === null ? [] : [event.newSporeId])]);
  const [held, moved, , current] = await db.batch([
    db.prepare(`SELECT 1 AS held FROM resolution_events WHERE project_id = ? AND id = ? AND ${owned.sql}`).bind(scope.projectId, event.id, ...owned.params),
    ...resolutionStatements(db, scope, status, event, now, expect, authority),
    db.prepare(`SELECT status, revision FROM spores WHERE project_id = ? AND id = ? AND ${owned.sql}`).bind(scope.projectId, event.sporeId, ...owned.params),
  ]);
  if (held!.results.length === 1) return 'duplicate';
  if (moved!.results.length === 1) return true;
  const row = current!.results[0] as { status: string; revision: number } | undefined;
  if (row === undefined) return false;
  const expected = expectedResolutionStatus(status, event, expect);
  const active = event.channel === 'import' && expected !== 'active' ? ' or active' : '';
  const revision = expect.revision === undefined ? '' : ` at revision ${expect.revision}`;
  return { error: 'stale', ...row,
    reason: `source is ${row.status} at revision ${row.revision}; expected ${expected}${active}${revision}` };
}

/**
 * Every spore recorded as superseding this one, newest first.
 *
 * Reads resolution events alone. The `graph_edges` half of 1.4's answer retires
 * with the semantic graph and carries nothing the events do not.
 */
export async function listSupersedingSporeIds(
  db: RelationalStore,
  scope: ReadScope,
  sporeId: string,
  limit = 10,
): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT new_spore_id AS id FROM resolution_events
       WHERE project_id = ? AND spore_id = ? AND action = 'supersede' AND new_spore_id IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`)
    .bind(scope.projectId, sporeId, limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Every spore this one replaced, newest first.
 *
 * The same events read from the other end: a supersede names one predecessor
 * and a consolidate names every source it merged, so a reader arriving at a
 * replacement sees what it grew out of rather than only where it leads.
 */
export async function listSupersededSporeIds(
  db: RelationalStore,
  scope: ReadScope,
  sporeId: string,
  limit = 10,
): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT spore_id AS id FROM resolution_events
       WHERE project_id = ? AND new_spore_id = ? AND action IN ('supersede', 'consolidate')
       ORDER BY created_at DESC LIMIT ?`)
    .bind(scope.projectId, sporeId, limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Record one wisdom spore and move every source to consolidated, each with its event, in one atomic batch that lands
 * only while every source is still active at its expected revision. When one changed, nothing is stored and `stale` names the
 * first source that changed, so the caller rereads it.
 */
export async function consolidateSpores(
  db: RelationalStore,
  scope: ReadScope,
  wisdom: SporeInsert,
  sources: readonly (string | SporeSource)[],
  event: Omit<ResolutionEventInsert, 'id' | 'sporeId' | 'action' | 'newSporeId'>,
  now: number, authority?: SporeAuthority,
): Promise<{ wisdom: SporeRow | null; consolidated: number; stale?: StaleConsolidationSource }> {
  const owned = grantSources(scope, authority, sources.map(source => typeof source === 'string' ? source : source.id));
  const expected = sources.map(source => typeof source === 'string' ? { id: source } : source);
  const insert = sporeInsert(db, scope, wisdom, false, owned);
  const moves = sources.flatMap(source => {
    const { id, revision } = typeof source === 'string' ? { id: source, revision: undefined } : source;
    return resolutionStatements(db, scope, 'consolidated', {
      ...event, id: crypto.randomUUID(), sporeId: id, action: 'consolidate', newSporeId: wisdom.id,
    }, now, { revision }, authority);
  });
  let results: Awaited<ReturnType<RelationalStore['batch']>>;
  try {
    results = await db.batch([consolidationSourcesCurrent(db, scope.projectId, expected), insert, ...moves]);
  } catch (error) {
    if (!consolidationSourcesChanged(error)) throw error;
    const stale = await staleConsolidationSource(db, scope.projectId, expected)
      ?? { id: expected[0]!.id, status: null, revision: null, expected: expected[0]!.revision ?? null };
    return { wisdom: null, consolidated: 0, stale };
  }
  const consolidated = moves.filter((_, i) => i % 2 === 0 && results[2 + i]!.results.length === 1).length;
  return { wisdom: (results[1]!.results[0] as SporeRow | undefined) ?? null, consolidated };
}

/** A spore of a read across Projects, with the Project it belongs to. */
export type SporeAcrossRow = SporeRow & { projectId: string };

/** How the spores a read across Projects admits divide by type and by Project. */
export type SporeFacets = SporeFacetCounts;

/** The list's time bound widened to whole UTC days, as epoch days and as the instants they start at. */
function windowOf(o: ListSporesOptions): { days: { fromDay?: number; toDay?: number }; window?: { from?: number; to?: number } } {
  const from = o.since === undefined ? o.createdFrom : o.createdFrom === undefined ? o.since : Math.max(o.since, o.createdFrom);
  const days = utcDays(from, o.createdTo);
  if (days.fromDay === undefined && days.toDay === undefined) return { days };
  return { days, window: {
    ...(days.fromDay === undefined ? {} : { from: days.fromDay * SPORE_DAY_MS }),
    ...(days.toDay === undefined ? {} : { to: days.toDay * SPORE_DAY_MS }),
  } };
}

/** The counter filters a list's filters are, or null for a list by agent, author or `includeActive: false`. */
function counted(o: ListSporesOptions): SporeCountFilters | null {
  if (o.agentId !== undefined || o.author !== undefined || o.includeActive === false) return null;
  return { status: o.status, observationType: o.observationType, sessionId: o.sessionId, ...windowOf(o).days };
}

const limitOf = (limit: number | undefined) => Math.min(Math.max(limit ?? DEFAULT_SPORE_LIMIT, 1), Math.min(MAX_SPORE_LIMIT, MAX_PAGE));
const filtersOf = (o: ListSporesOptions): SporeBrowseFilters => {
  const { window } = windowOf(o);
  return { agentId: o.agentId, author: o.author, observationType: o.observationType, status: o.status, sessionId: o.sessionId,
    createdFrom: window?.from, createdTo: window?.to, includeActive: o.includeActive };
};
const totalOf = (answer: { state: 'ready'; value: number } | { state: 'building' } | null): Pick<SporeListPage<unknown>, 'total' | 'counting'> =>
  answer === null ? {} : answer.state === 'ready' ? { total: answer.value } : { counting: 'building' };
const windowField = (o: ListSporesOptions) => { const { window } = windowOf(o); return window === undefined ? {} : { window }; };

/** The window a list's time bounds widen to, in ms (from inclusive, to exclusive), as its page and total read it. */
export const sporeListWindow = (o: Pick<ListSporesOptions, 'since' | 'createdFrom' | 'createdTo'>): { from?: number; to?: number } => windowOf(o).window ?? {};

/**
 * One page of a Project's spores, newest first with the id breaking a tie, and the cursor after its last row: a cursor
 * continues from that row whatever is written after it, so no row repeats and none is skipped. Null for a cursor this
 * list did not issue.
 */
export async function listSporePage(db: RelationalStore, scope: ReadScope, o: ListSporesOptions = {}): Promise<SporeListPage<SporeRow> | null> {
  const after: SporePageKey | null = o.cursor === undefined ? null : decodeCursor(o.cursor);
  if (o.cursor !== undefined && after === null) return null;
  const limit = limitOf(o.limit);
  const count = counted(o);
  const [rows, total] = await Promise.all([
    readSporePage(db, { scope, filters: filtersOf(o), after, limit }),
    count === null ? null : sporeTotal(db, scope, count),
  ]);
  const shown = rows.slice(0, limit).map(({ projectId: _projectId, ...row }) => row as unknown as SporeRow);
  const hasMore = rows.length > limit;
  const last = shown.at(-1);
  return { rows: shown, cursor: hasMore && last !== undefined ? encodeCursor(last.createdAt, last.id) : null, hasMore, ...totalOf(total), ...windowField(o) };
}

/**
 * One page of the spores of every Project in the set, newest first, then by id and Project, with the cursor after its
 * last row. The first page also carries `facets` where a counter answers the filters: each type's count over the named
 * Projects whatever type is chosen, and each visible Project's count whatever Projects are named. Null for a cursor this
 * list did not issue.
 */
export async function listSporePageAcross(db: RelationalStore, set: ProjectSet, o: ListSporesOptions = {}):
  Promise<(SporeListPage<SporeAcrossRow> & { facets?: SporeFacets }) | null> {
  const after = o.cursor === undefined ? null : decodeProjectCursor(o.cursor);
  if (o.cursor !== undefined && after === null) return null;
  const limit = limitOf(o.limit);
  const count = counted(o);
  const [rows, first, later] = await Promise.all([
    readSporePage(db, { scope: set, filters: filtersOf(o), after, limit }),
    count === null || after !== null ? null : sporeTotalAndFacets(db, set, count),
    count === null || after === null ? null : sporeTotal(db, set, count),
  ]);
  const shown = rows.slice(0, limit) as unknown as SporeAcrossRow[];
  const hasMore = rows.length > limit;
  const last = shown.at(-1);
  const totals = first === null ? totalOf(later) : first.state === 'building' ? { counting: 'building' as const }
    : { total: first.value.total, facets: first.value.facets };
  return {
    rows: shown, hasMore,
    cursor: hasMore && last !== undefined ? encodeProjectCursor({ createdAt: last.createdAt, projectId: last.projectId, id: last.id }) : null,
    ...totals, ...windowField(o),
  };
}
