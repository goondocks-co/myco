import { USER_AGENT_ID } from '../../constants.js';
import type { RelationalStore } from '../../core/adapters.js';
import { binaryOrder, type ProjectSet } from '../../read/scope.js';
import { read, readSet, type BindValue, type Statement } from '../index.js';

/**
 * Who a spore's author is. Every author a write records is a run's id, a member's or a grant's (`mcp/context.ts
 * writerOf`). Members and grants are never deleted, and a run is pruned by retention, so an author that names no
 * member and no grant is a run's, whether or not the run is still held. A member writes as the `user` agent; a spore a
 * member's credential carried in under another agent is one the 1.4 import brought over (`/spores/save`, which stamps
 * the importing member as author and keeps 1.4's agent), and reads `imported`.
 */
const AUTHOR_KIND = `CASE WHEN spores.author IS NULL THEN NULL
  WHEN EXISTS (SELECT 1 FROM members m WHERE m.id = spores.author) THEN CASE WHEN spores.agent_id = '${USER_AGENT_ID}' THEN 'member' ELSE 'imported' END
  WHEN EXISTS (SELECT 1 FROM external_grants g WHERE g.id = spores.author) THEN 'grant'
  ELSE 'run' END`;

/** A spore's stored fields under the names the server answers with. */
export const SPORE_COLUMNS = `id, agent_id AS agentId, session_id AS sessionId,
  observation_type AS observationType, status, revision, content, context, importance,
  file_path AS filePath, tags, content_hash AS contentHash, properties, author,
  provenance_kind AS provenanceKind, provenance_ref AS provenanceRef, agent_line AS agentLine,
  created_at AS createdAt, updated_at AS updatedAt, embedded`;
/** A read's columns: the row, and who its author is. */
export const SPORE_READ_COLUMNS = `${SPORE_COLUMNS}, ${AUTHOR_KIND} AS authorKind`;

/** The structured filters a spore list takes. Free text is not one: a text match is a search (`/api/search`, `myco_search`). */
export interface SporeBrowseFilters {
  agentId?: string;
  author?: string;
  observationType?: string;
  status?: string;
  sessionId?: string;
  /** Written at or after this instant (ms). */
  createdFrom?: number;
  /** Written before this instant (ms). */
  createdTo?: number;
  /** False leaves out spores whose session has not ended; a `sessionId` read is never gated. */
  includeActive?: boolean;
}

/** The key after which a page starts: within one Project the instant and the id; across Projects the Project too. */
export interface SporePageKey { createdAt: number; projectId?: string; id: string }

/** One Project; every visible Project; or one Project of a named set, read in the order across Projects. */
type Scope = 'project' | 'all' | 'member';
const FILTERS = ['agent', 'author', 'type', 'status', 'session', 'from', 'to', 'settled', 'after'] as const;
type Flag = (typeof FILTERS)[number];
const CONDITION: Record<Exclude<Flag, 'after'>, string> = {
  agent: 'agent_id = {agent}',
  author: 'author = {author}',
  type: 'observation_type = {type}',
  status: 'status = {status}',
  session: 'session_id = {session}',
  from: 'created_at >= {from}',
  to: 'created_at < {to}',
  // A spore from a session still in flight is not settled yet.
  settled: `(session_id IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.project_id = spores.project_id
    AND s.session_id = spores.session_id AND s.ended_at IS NOT NULL))`,
};

/**
 * The index a page walks, led by its most selective structured filter and ending in the page's own order (instant, id,
 * and across Projects the Project), so a page reads its rows and the ones its other filters pass over and never sorts:
 * within one Project, also one Project of a named set, a session, author, status or type index, or the Project's own
 * order; across every Project a status or type index, or the Deployment-wide order.
 */
function indexOf(scope: Scope, flags: ReadonlySet<Flag>): string {
  if (scope === 'all') return flags.has('status') ? 'idx_spores_status_deployment' : flags.has('type') ? 'idx_spores_type_deployment' : 'idx_spores_created_deployment';
  if (flags.has('session')) return 'idx_spores_session';
  if (flags.has('author')) return 'idx_spores_author';
  if (flags.has('status')) return 'idx_spores_status';
  if (flags.has('type')) return 'idx_spores_type';
  return 'idx_spores_project_created';
}

interface Variant { statement: Statement<BindValue[], Record<string, unknown>, 'read'>; slots: readonly string[] }
const VARIANTS = new Map<string, Variant>();

/** One statement per filter shape, defined the first time a list asks for that shape: `{name}` markers become numbered slots. */
function variant(scope: Scope, flags: ReadonlySet<Flag>): Variant {
  const key = `${scope}${FILTERS.filter(f => flags.has(f)).map(f => f[0]!.toUpperCase() + f.slice(1)).join('')}`;
  const held = VARIANTS.get(key);
  if (held !== undefined) return held;
  const across = scope !== 'project';
  const conditions = [
    scope === 'all' ? 'EXISTS (SELECT 1 FROM projects p WHERE p.project_id = spores.project_id AND p.archived_at IS NULL)' : 'project_id = {project}',
    ...FILTERS.filter((f): f is Exclude<Flag, 'after'> => f !== 'after' && flags.has(f)).map(f => CONDITION[f]),
  ];
  if (flags.has('after')) conditions.push(across
    ? 'created_at <= {at} AND (created_at < {at} OR (created_at = {at} AND (id < {afterId} OR (id = {afterId} AND project_id < {afterProject}))))'
    : 'created_at <= {at} AND (created_at < {at} OR (created_at = {at} AND id < {afterId}))');
  const template = `SELECT project_id AS projectId, ${SPORE_READ_COLUMNS} FROM spores INDEXED BY ${indexOf(scope, flags)}
    WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id DESC${across ? ', project_id DESC' : ''} LIMIT {limit}`;
  const slots: string[] = [];
  const sql = template.replace(/\{([a-z]+)\}/gi, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  const made = { statement: read<BindValue[], Record<string, unknown>>({ name: `sporeBrowse.${key}`, sql }), slots };
  VARIANTS.set(key, made);
  return made;
}

/**
 * One spore page as stored rows with their Project, at most `limit` + 1 of them, newest first with the id (and across
 * Projects the Project) breaking a tie. Across every Project the read walks a Deployment-wide index and stops at its
 * page. A named set of Projects reads each Project's own next page through that Project's indexes, all in one read
 * set, and merges them in the order across Projects: the work is the set's pages, whatever other Projects hold.
 */
export async function readSporePage(db: RelationalStore, request: {
  scope: { projectId: string } | ProjectSet; filters: SporeBrowseFilters; after: SporePageKey | null; limit: number;
}): Promise<Record<string, unknown>[]> {
  const { scope, filters: f, after, limit } = request;
  const values: Record<string, BindValue> = {
    project: 'projectId' in scope ? scope.projectId : null,
    agent: f.agentId ?? null, author: f.author ?? null, type: f.observationType ?? null, status: f.status ?? null,
    session: f.sessionId ?? null, from: f.createdFrom ?? null, to: f.createdTo ?? null,
    at: after?.createdAt ?? null, afterId: after?.id ?? null, afterProject: after?.projectId ?? null, limit: limit + 1,
  };
  const flags = new Set<Flag>();
  if (f.agentId !== undefined) flags.add('agent');
  if (f.author !== undefined) flags.add('author');
  if (f.observationType !== undefined) flags.add('type');
  if (f.status !== undefined) flags.add('status');
  if (f.sessionId !== undefined) flags.add('session');
  if (f.createdFrom !== undefined) flags.add('from');
  if (f.createdTo !== undefined) flags.add('to');
  if (f.includeActive === false && f.sessionId === undefined) flags.add('settled');
  if (after !== null) flags.add('after');
  if ('projectId' in scope || scope.all) {
    const { statement, slots } = variant('projectId' in scope ? 'project' : 'all', flags);
    const [rows] = await readSet(db, statement.bind(...slots.map(slot => values[slot]!)));
    return rows;
  }
  if (scope.projectIds.length === 0) return [];
  const { statement, slots } = variant('member', flags);
  const pages = await readSet(db, ...scope.projectIds.map(projectId => statement.bind(...slots.map(slot => (slot === 'project' ? projectId : values[slot]!)))));
  const at = (row: Record<string, unknown>) => ({ createdAt: Number(row.createdAt), id: String(row.id), projectId: String(row.projectId) });
  return pages.flat().sort((left, right) => {
    const a = at(left), b = at(right);
    return b.createdAt - a.createdAt || binaryOrder(b.id, a.id) || binaryOrder(b.projectId, a.projectId);
  }).slice(0, limit + 1);
}
