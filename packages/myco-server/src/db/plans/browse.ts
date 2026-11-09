import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { processedResourceProofSql } from '../../core/processed-resources.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet, type BindValue, type Statement } from '../index.js';

/** A plan's stored fields, with the object key of a body spilled to a blob once its processing is proven. */
export const PLAN_COLUMNS = `plan_key, session_id, prompt_id, title, status, content, blob_key,
  CASE WHEN ${processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')}
    THEN ${registeredObjectKeySql('plans.project_id', 'plans.blob_key')} END AS object_key,
  origin_path, updated_by, created_at, updated_at`;

/** The Deployment-wide order every read of plans across Projects walks: the update, the key, then the Project. */
const PLANS_ACROSS_INDEX = 'idx_plans_updated_deployment';

/** A plan list's structured filters; a text match is a search (`/api/search`). */
interface PlanBrowseFilters { status?: string; sessionId?: string; since?: number }

/** The key after which a page starts: within one Project the update and the key; across Projects the Project too. */
interface PlanPageKey { createdAt: number; projectId?: string; id: string }

/** A named set of Projects binds once as `,id,id,`: the Project id grammar holds no comma, so membership is one exact check per row. */
type Scope = 'project' | 'all' | 'named';
interface Shape { scope: Scope; status: boolean; session: boolean; since: boolean; after: boolean }
interface Variant { statement: Statement<BindValue[], Record<string, unknown>, 'read'>; slots: readonly string[] }
const flags = [false, true] as const;
const cap = (word: string, on: boolean) => (on ? word : '');

/** `{name}` markers become numbered slots in order of first use. */
function define(name: string, template: string): Variant {
  const slots: string[] = [];
  const sql = template.replace(/\{([a-z]+)\}/gi, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  return { statement: read<BindValue[], Record<string, unknown>>({ name, sql }), slots };
}

function variantSql({ scope, status, session, since, after }: Shape): string {
  const across = scope !== 'project';
  const conditions = [
    scope === 'project' ? 'project_id = {project}'
      : scope === 'all' ? 'EXISTS (SELECT 1 FROM projects p WHERE p.project_id = plans.project_id AND p.archived_at IS NULL)'
      : "instr({projects}, ',' || plans.project_id || ',') > 0",
    status ? 'status = {status}' : across ? '({status} IS NULL OR status = {status})' : '1',
    session ? 'session_id = {session}' : '1',
  ];
  if (since) conditions.push('updated_at >= {since}');
  if (after) conditions.push(across
    ? 'updated_at <= {at} AND (updated_at < {at} OR (updated_at = {at} AND (plan_key < {afterId} OR (plan_key = {afterId} AND project_id < {afterProject}))))'
    : 'updated_at <= {at} AND (updated_at < {at} OR (updated_at = {at} AND plan_key < {afterId}))');
  return `SELECT project_id, ${PLAN_COLUMNS} FROM plans${across ? ` INDEXED BY ${PLANS_ACROSS_INDEX}` : ''} WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, plan_key DESC${across ? ', project_id DESC' : ''} LIMIT {limit}`;
}

const keyOf = (shape: Shape) => `${shape.scope}${cap('Status', shape.status)}${cap('Session', shape.session)}${cap('Since', shape.since)}`
  + `${cap('After', shape.after)}`;

/**
 * Every plan page variant the plan lists use, defined once. A one-Project page takes a status and a session, each sought
 * on its own index; a page across Projects takes a status checked per row as it walks the Deployment-wide index, and a
 * start instant.
 */
const VARIANTS = new Map<string, Variant>();
for (const scope of ['project', 'all', 'named'] as const) for (const status of flags) for (const session of flags)
  for (const since of flags) for (const after of flags) {
    if (scope === 'project' ? since : status || session) continue;
    const shape: Shape = { scope, status, session, since, after };
    VARIANTS.set(keyOf(shape), define(`planBrowse.${keyOf(shape)}`, variantSql(shape)));
  }

/**
 * One plan page as stored rows with their Project, at most `limit` + 1 of them, most recently updated first. A read
 * across Projects walks the Deployment-wide index and orders by the update, the key and the Project.
 */
export async function readPlanPage(db: RelationalStore, request: {
  scope: { projectId: string } | ProjectSet; filters: PlanBrowseFilters; after: PlanPageKey | null; limit: number;
}): Promise<Record<string, unknown>[]> {
  const { scope, filters, after, limit } = request;
  const kind: Scope = 'projectId' in scope ? 'project' : scope.all ? 'all' : 'named';
  const values: Record<string, BindValue> = {
    project: 'projectId' in scope ? scope.projectId : null,
    projects: !('projectId' in scope) && !scope.all ? `,${scope.projectIds.join(',')},` : null,
    status: filters.status ?? null, session: filters.sessionId ?? null, since: filters.since ?? null,
    at: after?.createdAt ?? null, afterProject: after?.projectId ?? null, afterId: after?.id ?? null, limit: limit + 1,
  };
  const key = keyOf({ scope: kind, status: kind === 'project' && filters.status !== undefined,
    session: filters.sessionId !== undefined, since: filters.since !== undefined, after: after !== null });
  const variant = VARIANTS.get(key);
  if (variant === undefined) throw new Error(`no plan page variant ${key}: a plan list takes only the filters its operation declares`);
  const [rows] = await readSet(db, variant.statement.bind(...variant.slots.map(slot => values[slot]!)));
  return rows;
}
