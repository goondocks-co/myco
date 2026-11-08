import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { processedResourceProofSql } from '../../core/processed-resources.js';
import { containsPattern, type ProjectSet } from '../../read/scope.js';
import { read, readSet, type BindValue, type Statement } from '../index.js';

/** A plan's stored fields, with the object key of a body spilled to a blob once its processing is proven. */
export const PLAN_COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key,
  CASE WHEN ${processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')}
    THEN ${registeredObjectKeySql('plans.project_id', 'plans.blob_key')} END AS object_key,
  origin_path, updated_by, created_at, updated_at`;

/** The Deployment-wide order every read of plans across Projects walks: the update, the key, then the Project. */
const PLANS_ACROSS_INDEX = 'idx_plans_updated_deployment';

/**
 * The plans a text matches: its title or its body as the Deployment holds it inline, with `%` and `_` read as text.
 * Case is folded for ASCII letters only: `é` does not match `É`. A body spilled to a blob is matched by
 * `/api/search`, not here.
 */
export function planText(q: string | undefined): { sql: string; params: string[] } | null {
  if (q === undefined || q.trim() === '') return null;
  const pattern = containsPattern(q.trim());
  return { sql: `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`, params: [pattern, pattern] };
}

export interface PlanBrowseFilters { status?: string; sessionId?: string; since?: number; q?: string }

/** The key after which a page starts: within one Project the update and the key; across Projects the Project too. */
export interface PlanPageKey { createdAt: number; projectId?: string; id: string }

/** A named set of Projects binds once as `,id,id,`: the Project id grammar holds no comma, so membership is one exact check per row. */
type Scope = 'project' | 'all' | 'named';
interface Shape { scope: Scope; status: boolean; session: boolean; since: boolean; text: boolean; after: boolean }
interface Variant { statement: Statement<BindValue[], Record<string, unknown>, 'read'>; slots: readonly string[] }
const flags = [false, true] as const;
const cap = (word: string, on: boolean) => (on ? word : '');

/** `{name}` markers become numbered slots in order of first use; a name in `like` declares its slot a LIKE pattern. */
function define(name: string, template: string, like: readonly string[]): Variant {
  const slots: string[] = [];
  const sql = template.replace(/\{([a-z]+)\}/gi, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  return { statement: read<BindValue[], Record<string, unknown>>({ name, sql, like: like.map(slot => slots.indexOf(slot) + 1) }), slots };
}

function variantSql({ scope, status, session, since, text, after }: Shape): string {
  const across = scope !== 'project';
  const conditions = [
    scope === 'project' ? 'project_id = {project}'
      : scope === 'all' ? 'EXISTS (SELECT 1 FROM projects p WHERE p.project_id = plans.project_id AND p.archived_at IS NULL)'
      : "instr({projects}, ',' || plans.project_id || ',') > 0",
    status ? 'status = {status}' : across ? '({status} IS NULL OR status = {status})' : '1',
    session ? 'session_id = {session}' : '1',
  ];
  if (since) conditions.push('updated_at >= {since}');
  if (text) conditions.push(`(title LIKE {pattern} ESCAPE '\\' OR content LIKE {pattern} ESCAPE '\\')`);
  if (after) conditions.push(across
    ? 'updated_at <= {at} AND (updated_at < {at} OR (updated_at = {at} AND (plan_key < {afterId} OR (plan_key = {afterId} AND project_id < {afterProject}))))'
    : 'updated_at <= {at} AND (updated_at < {at} OR (updated_at = {at} AND plan_key < {afterId}))');
  return `SELECT project_id, ${PLAN_COLUMNS} FROM plans${across ? ` INDEXED BY ${PLANS_ACROSS_INDEX}` : ''} WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, plan_key DESC${across ? ', project_id DESC' : ''} LIMIT {limit}`;
}

const keyOf = (shape: Shape) => `${shape.scope}${cap('Status', shape.status)}${cap('Session', shape.session)}${cap('Since', shape.since)}`
  + `${cap('Text', shape.text)}${cap('After', shape.after)}`;

/**
 * Every plan page variant the plan lists use, defined once. A one-Project page takes a status and a session, each sought
 * on its own index; a page across Projects takes a status checked per row as it walks the Deployment-wide index, a
 * start instant and a text.
 */
const VARIANTS = new Map<string, Variant>();
for (const scope of ['project', 'all', 'named'] as const) for (const status of flags) for (const session of flags)
  for (const since of flags) for (const text of flags) for (const after of flags) {
    if (scope === 'project' ? since || text : status || session) continue;
    const shape: Shape = { scope, status, session, since, text, after };
    VARIANTS.set(keyOf(shape), define(`planBrowse.${keyOf(shape)}`, variantSql(shape), text ? ['pattern'] : []));
  }

/**
 * One plan page as stored rows with their Project, at most `limit` + 1 of them, most recently updated first. A read
 * across Projects walks the Deployment-wide index and orders by the update, the key and the Project. A text whose
 * escaped pattern exceeds the store's LIKE limit is refused before any read.
 */
export async function readPlanPage(db: RelationalStore, request: {
  scope: { projectId: string } | ProjectSet; filters: PlanBrowseFilters; after: PlanPageKey | null; limit: number;
}): Promise<Record<string, unknown>[]> {
  const { scope, filters, after, limit } = request;
  const kind: Scope = 'projectId' in scope ? 'project' : scope.all ? 'all' : 'named';
  const text = filters.q !== undefined && filters.q.trim() !== '';
  const values: Record<string, BindValue> = {
    project: 'projectId' in scope ? scope.projectId : null,
    projects: !('projectId' in scope) && !scope.all ? `,${scope.projectIds.join(',')},` : null,
    status: filters.status ?? null, session: filters.sessionId ?? null, since: filters.since ?? null,
    pattern: text ? containsPattern(filters.q!.trim()) : null,
    at: after?.createdAt ?? null, afterProject: after?.projectId ?? null, afterId: after?.id ?? null, limit: limit + 1,
  };
  const key = keyOf({ scope: kind, status: kind === 'project' && filters.status !== undefined,
    session: filters.sessionId !== undefined, since: filters.since !== undefined, text, after: after !== null });
  const variant = VARIANTS.get(key);
  if (variant === undefined) throw new Error(`no plan page variant ${key}: a plan list takes only the filters its operation declares`);
  const [rows] = await readSet(db, variant.statement.bind(...variant.slots.map(slot => values[slot]!)));
  return rows;
}
