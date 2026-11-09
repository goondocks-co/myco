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
import type { RelationalStore } from './adapters.js';
import { decodeCursor, encodeCursor, MAX_PAGE, type ProjectSet, type ReadScope } from '../read/scope.js';
import { decodeProjectCursor, encodeProjectCursor } from '../read/project-cursor.js';
import { readSporePage, type SporeBrowseFilters, type SporePageKey } from '../db/spores/browse.js';
import { SPORE_DAY_MS, sporeTotal, sporeTotalAndFacets, utcDays, type SporeCountFilters, type SporeFacetCounts } from '../db/spores/counts.js';

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
interface SporeListPage<T> {
  rows: T[];
  cursor: string | null;
  hasMore: boolean;
  total?: number;
  counting?: 'building';
  window?: { from?: number; to?: number };
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
