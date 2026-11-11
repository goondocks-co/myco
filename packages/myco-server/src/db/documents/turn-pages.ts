import type { RelationalStore } from '../../core/adapters.js';
import { readSlotted, slottedRead, type SlottedRead } from '../slotted-read.js';
import { liveGenerationSql } from './live-generation.js';

/** The turns a read lists: a filter narrows them, `key` reads the cards marked high signal. */
export type TurnFilter = 'key' | 'failed' | 'myco';
/** Which prompt origins count: only a person's, every origin, or a named set. */
export type OriginScope = 'user' | 'all' | readonly string[];
type Direction = 'ASC' | 'DESC';
type Boundary = 'none' | 'after' | 'from';

export interface TurnPageRow {
  prompt_id: string; origin: string | null; prompt_kind: string | null; thread_label: string | null; preview: string | null; text_chars: number | null;
  created_at: number; position: number; tools: number; replies: number; children: number; plans: number; failed_tools: number; myco_calls: number;
  tool_rollup: string | null; headline: string | null; signal: 'high' | 'low' | 'none' | null; marks: string | null; attachments: number;
}

interface Shape { filter: TurnFilter | 'all'; origins: 'user' | 'all' | 'set'; exact: boolean; order: Direction; boundary: Boundary }

const flags = [false, true] as const;

function variantSql(shape: Shape): string {
  const key = shape.filter === 'key';
  const column = key ? 'c.created_at' : 'p.ord';
  const id = key ? 'c.turn_key' : 'p.prompt_id';
  const conditions = ['p.project_id = {project}', 'p.session_id = {session}', `p.generation = ${liveGenerationSql('{project}', '{session}')}`, 'p.turn_key = p.prompt_id'];
  if (shape.origins === 'user') conditions.push(`p.origin='user'`);
  else if (shape.origins === 'set') conditions.push('p.origin IN (SELECT value FROM json_each({origins}))');
  if (key) conditions.push('c.project_id = {project}', 'c.session_id = {session}', `c.signal = 'high'`);
  if (shape.filter === 'failed') conditions.push('p.failed_tools > 0');
  if (shape.filter === 'myco') conditions.push('p.myco_calls > 0');
  if (shape.exact) conditions.push('p.prompt_id={turn}');
  if (shape.boundary !== 'none') {
    const compare = (shape.order === 'ASC' ? '>' : '<') + (shape.boundary === 'from' ? '=' : '');
    conditions.push(`(${column},${id}) ${compare} ({at},{afterId})`);
  }
  const source = key && !shape.exact
    ? `turn_cards c INDEXED BY idx_turn_cards_key CROSS JOIN session_prompts p
          ON p.project_id=c.project_id AND p.session_id=c.session_id AND p.prompt_id=c.turn_key`
    : `session_prompts p ${shape.exact ? '' : shape.filter === 'failed' || shape.filter === 'myco' ? `INDEXED BY idx_session_prompts_${shape.filter}` : shape.origins === 'user' ? 'INDEXED BY idx_session_prompts_user_turns' : ''}
          LEFT JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.prompt_id`;
  return `SELECT p.prompt_id,p.origin,p.prompt_kind,p.thread_label,p.preview,p.text_chars,p.created_at,
        ${column} AS position,p.tools,p.replies,p.children,p.plans,p.failed_tools,p.myco_calls,p.tool_rollup,c.headline,c.signal,c.marks,
        (SELECT COUNT(*) FROM attachments a WHERE a.project_id=p.project_id AND a.session_id=p.session_id AND a.prompt_id=p.prompt_id) AS attachments
      FROM ${source} WHERE ${conditions.join(' AND ')}
      ORDER BY ${column} ${shape.order},${id} ${shape.order} LIMIT {limit}`;
}

const keyOf = (s: Shape) => `${s.filter}${s.origins[0]!.toUpperCase()}${s.origins.slice(1)}${s.exact ? 'Turn' : ''}${s.order === 'ASC' ? 'Asc' : 'Desc'}${s.boundary === 'none' ? '' : s.boundary === 'after' ? 'After' : 'From'}`;

/** Every variant of the turn page, defined once: the filter, the origin scope, a named turn, the direction and a boundary key. */
const VARIANTS = new Map<string, SlottedRead<TurnPageRow>>();
for (const filter of ['all', 'key', 'failed', 'myco'] as const) for (const origins of ['user', 'all', 'set'] as const)
  for (const exact of flags) for (const order of ['ASC', 'DESC'] as const) for (const boundary of ['none', 'after', 'from'] as const) {
    const shape: Shape = { filter, origins, exact, order, boundary };
    VARIANTS.set(keyOf(shape), slottedRead<TurnPageRow>(`turnPages.${keyOf(shape)}`, variantSql(shape)));
  }

export interface TurnPageRequest {
  project: string;
  session: string;
  filter?: TurnFilter;
  origins: OriginScope;
  /** A turn to return alone. */
  turn?: string;
  order: Direction;
  /** The key a page starts after, or at when `inclusive`; null for the first page. */
  boundary: { createdAt: number; id: string; inclusive: boolean } | null;
  limit: number;
}

/** One page of a session's top-level prompt rows in the live document, in turn order or by card time for the key turns. */
export async function turnPageRows(db: RelationalStore, request: TurnPageRequest): Promise<TurnPageRow[]> {
  const { origins, boundary } = request;
  const shape: Shape = { filter: request.filter ?? 'all', origins: origins === 'user' || origins === 'all' ? origins : 'set', exact: request.turn !== undefined,
    order: request.order, boundary: boundary === null ? 'none' : boundary.inclusive ? 'from' : 'after' };
  const variant = VARIANTS.get(keyOf(shape));
  if (variant === undefined) throw new Error(`no turn page variant ${keyOf(shape)}`);
  return readSlotted(db, variant, {
    project: request.project, session: request.session, origins: typeof origins === 'string' ? null : JSON.stringify(origins),
    turn: request.turn ?? null, at: boundary?.createdAt ?? null, afterId: boundary?.id ?? null, limit: request.limit,
  });
}
