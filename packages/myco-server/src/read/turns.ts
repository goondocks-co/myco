/**
 * A session read as turns: each top-level prompt with what followed it — the
 * tool calls, responses, attachments and steering prompts that name it. The
 * dashboard's session page renders the list collapsed (a preview per turn) and
 * fetches one turn's body when it opens, so the list carries counts and a
 * preview, never a prompt's full text.
 */
import { sourceTimestampsRecorded } from '@goondocks/myco-shared/capture-rules';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { uuidv5 } from '../hash.js';
import type { RelationalStore } from '../core/adapters.js';
import { oneLine, type PromptInjection } from '../core/injection.js';
import { listSporesByIds, MAX_SPORE_LIMIT } from '../core/spores.js';
import { PROMPT_ORIGINS } from '../ingest/kinds.js';
import { ATTACHMENT_QUERY, TURN_PLAN_QUERY, RESPONSE_QUERY, listChildren, listChildrenByPrompt, type AttachmentRow, type PlanRow, type ResponseRow } from './children.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** How much of a prompt's inline text the list row carries. */
export const TURN_PREVIEW_CHARS = 160;
/** How many items each turn collection carries before its paged continuation. */
export const TURN_BODY_LIMIT = 50;
/** The origin the list shows when the caller names none: what a person typed. */
export const DEFAULT_ORIGINS: readonly string[] = ['user'];

export interface TurnRow {
  promptId: string;
  origin: string;
  promptKind: string | null;
  threadLabel: string | null;
  /** The opening of the inline text; null when the text spilled to a blob. */
  preview: string | null;
  /** The inline text's length in characters; null when it spilled. */
  textChars: number | null;
  blobKey: string | null;
  createdAt: number;
  toolCallCount: number;
  responseCount: number;
  /** Steering and interrupt prompts that name this one as their parent. */
  childCount: number;
  planCount: number;
  attachmentCount: number;
}

export interface TurnPrompt {
  promptId: string;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
}

export interface TurnChild {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  toolCallCount: number;
  responsesCursor: string | null;
  body: TurnDetail;
  childCount: number;
}

export interface TurnDetail {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  attachments: AttachmentRow[];
  /** The plans this prompt produced, in immutable key order. */
  plans: PlanRow[];
  /** The spores and plans Myco served with this prompt, hydrated from retained records; null when it served none. */
  injection: (PromptInjection & { planIds: string[]; plans: Array<{ planKey: string; title: string | null }> }) | null;
  metrics: TurnMetrics;
  answers: PromptAnswer[];
  children: TurnChild[];
  cursors: Record<TurnCollection, string | null>;
}

export const TURN_COLLECTIONS = ['responses', 'attachments', 'plans', 'children', 'answers'] as const;
export type TurnCollection = (typeof TURN_COLLECTIONS)[number];

/** The origins a query names, or null when one is not an origin the wire admits. Absent means the default. */
export function parseOrigins(raw: string | null): readonly string[] | null {
  if (raw === null || raw === '') return DEFAULT_ORIGINS;
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (names.length === 0) return null;
  const admitted = new Set<string>(PROMPT_ORIGINS);
  return names.every((n) => admitted.has(n)) ? [...new Set(names)] : null;
}

const PROMPT_COLUMNS = 'pb.prompt_id, pb.origin, pb.prompt_kind, pb.parent_prompt_id, pb.thread_label, pb.text, pb.blob_key, pb.created_at';

function toPrompt(r: Record<string, unknown>): TurnPrompt {
  return {
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    parentPromptId: (r.parent_prompt_id as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

const TOOL_CALL_COUNT = `(SELECT COUNT(*) FROM tool_calls t WHERE t.project_id = pb.project_id AND t.session_id = pb.session_id AND t.prompt_id = pb.prompt_id)`;
const RESPONSE_COUNT = `(SELECT COUNT(*) FROM responses r WHERE r.project_id = pb.project_id AND r.prompt_id = pb.prompt_id)`;
const PLAN_COUNT = `(SELECT COUNT(*) FROM plans p WHERE p.project_id = pb.project_id AND p.session_id = pb.session_id AND p.prompt_id = pb.prompt_id)`;
const ATTACHMENT_COUNT = `(SELECT COUNT(*) FROM attachments a WHERE a.project_id = pb.project_id AND a.session_id = pb.session_id AND a.prompt_id = pb.prompt_id)`;
const CHILD_COUNT = `(SELECT COUNT(*) FROM prompt_batches c WHERE c.project_id = pb.project_id AND c.session_id = pb.session_id AND c.parent_prompt_id = pb.prompt_id)`;

/** A session's top-level prompts, keyset-paged in the requested direction; a named prompt resolves to its turn. */
export async function listTurns(db: RelationalStore, scope: ReadScope, sessionId: string, opts: { origins?: readonly string[]; limit?: number; cursor?: string; order?: 'ASC' | 'DESC'; promptId?: string } = {}): Promise<Page<TurnRow>> {
  const direction = opts.order ?? 'ASC';
  const k = keyset(opts, { order: 'pb.created_at', id: 'pb.prompt_id', direction });
  if (k === null) return { rows: [], cursor: null };
  const origins = opts.origins ?? DEFAULT_ORIGINS;
  if (origins.length === 0) return { rows: [], cursor: null };
  const conditions = ['pb.project_id = ?', 'pb.session_id = ?', 'pb.parent_prompt_id IS NULL', `pb.origin IN (${origins.map(() => '?').join(', ')})`];
  const params: unknown[] = [scope.projectId, sessionId, ...origins];
  if (opts.promptId !== undefined) {
    conditions.push(`pb.prompt_id = (SELECT COALESCE(parent_prompt_id, prompt_id) FROM prompt_batches WHERE project_id = ? AND session_id = ? AND prompt_id = ?)`);
    params.push(scope.projectId, sessionId, opts.promptId);
  }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const { results } = await db
    .prepare(`SELECT pb.prompt_id, pb.origin, pb.prompt_kind, pb.thread_label, substr(pb.text, 1, ${TURN_PREVIEW_CHARS}) AS preview, length(pb.text) AS text_chars, pb.blob_key, pb.created_at,
                     ${TOOL_CALL_COUNT} AS tool_call_count, ${RESPONSE_COUNT} AS response_count, ${CHILD_COUNT} AS child_count, ${PLAN_COUNT} AS plan_count, ${ATTACHMENT_COUNT} AS attachment_count
                FROM prompt_batches pb
               WHERE ${conditions.join(' AND ')}
               ORDER BY pb.created_at ${direction}, pb.prompt_id ${direction} LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const rows: TurnRow[] = results.map((r) => ({
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    preview: (r.preview as string | null) ?? null,
    textChars: (r.text_chars as number | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
    toolCallCount: r.tool_call_count as number,
    responseCount: r.response_count as number,
    childCount: r.child_count as number,
    planCount: r.plan_count as number,
    attachmentCount: r.attachment_count as number,
  }));
  return page(rows, k.limit, (r) => ({ createdAt: r.createdAt, id: r.promptId }));
}

/** True when a prompt of that id sits in the session. */
export async function promptInSession(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM prompt_batches WHERE project_id = ? AND session_id = ? AND prompt_id = ?`)
    .bind(scope.projectId, sessionId, promptId)
    .first<{ present: number }>();
  return row !== null;
}

/** One turn's body, or null when no prompt of that id sits in the session. Tool calls are not here: they are read on their own, page by page, when the reader opens them. */
export async function turnDetail(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<TurnDetail | null> {
  const children = await steeringChildPage(db, scope, sessionId, promptId, { limit: TURN_BODY_LIMIT });
  const bodies = await readTurnBodies(db, scope, sessionId, [promptId, ...children.rows.map(r => r.prompt_id as string)]);
  const body = bodies.get(promptId);
  if (body === undefined) return null;
  body.children = [...steeringBodies(children, bodies).rows];
  body.cursors.children = children.cursor;
  return body;
}

/** First pages are hydrated in bulk; each child keeps its own collection cursors. */
async function readTurnBodies(db: RelationalStore, scope: ReadScope, sessionId: string, promptIds: readonly string[]): Promise<Map<string, TurnDetail>> {
  const bodies = new Map<string, TurnDetail>();
  if (promptIds.length === 0) return bodies;
  const { results } = await db.prepare(`SELECT ${PROMPT_COLUMNS},
    (SELECT MAX(+created_at) FROM responses WHERE project_id = pb.project_id AND session_id = pb.session_id AND prompt_id = pb.prompt_id) AS last_reply,
    (SELECT json_group_array(json_object('toolName', tool_name, 'count', n)) FROM (
      ${toolUsageSql(true, true)})) AS tools,
    (SELECT json_object('sporeIds', i.spore_ids, 'createdAt', i.created_at, 'planIds', json(COALESCE(i.plan_ids, '[]')),
      'plans', json((SELECT json_group_array(json_object('planKey', p.plan_key, 'title', p.title))
        FROM plans p WHERE p.project_id = i.project_id AND p.plan_key IN (SELECT value FROM json_each(i.plan_ids)))))
      FROM spore_injections i WHERE i.project_id = pb.project_id AND i.session_id = pb.session_id AND i.prompt_id = pb.prompt_id
      ORDER BY +i.created_at DESC LIMIT 1) AS injection,
    (SELECT agent FROM sessions s WHERE s.project_id = pb.project_id AND s.session_id = pb.session_id) AS agent
    FROM (SELECT value AS wanted_prompt FROM json_each(?)) wanted CROSS JOIN prompt_batches pb
    WHERE pb.project_id = ? AND pb.session_id = ? AND pb.prompt_id = wanted.wanted_prompt`)
    .bind(JSON.stringify(promptIds), scope.projectId, sessionId).all<Record<string, unknown>>();
  const ids = results.map(r => r.prompt_id as string);
  const [responses, attachments, plans, answers] = await Promise.all([
    listChildrenByPrompt(db, RESPONSE_QUERY, scope, sessionId, ids, TURN_BODY_LIMIT),
    listChildrenByPrompt(db, ATTACHMENT_QUERY, scope, sessionId, ids, TURN_BODY_LIMIT),
    listChildrenByPrompt(db, TURN_PLAN_QUERY, scope, sessionId, ids, TURN_BODY_LIMIT),
    listChildrenByPrompt(db, ANSWER_QUERY, scope, sessionId, ids, TURN_BODY_LIMIT),
  ]);
  type Served = { sporeIds: string[]; createdAt: number; planIds: string[]; plans: Array<{ planKey: string; title: string | null }> };
  const served = new Map(results.map(r => {
    const raw = r.injection === null ? null : JSON.parse(r.injection as string) as Omit<Served, 'sporeIds'> & { sporeIds: string };
    return [r.prompt_id as string, raw === null ? null : { ...raw, sporeIds: retainedIds(raw.sporeIds) }] as const;
  }));
  const sporeIds = [...new Set([...served.values()].flatMap(i => i?.sporeIds ?? []))];
  const spores = [];
  for (let offset = 0; offset < sporeIds.length; offset += MAX_SPORE_LIMIT) spores.push(...await listSporesByIds(db, scope, sporeIds.slice(offset, offset + MAX_SPORE_LIMIT)));
  const byId = new Map(spores.map(spore => [spore.id, spore]));
  for (const row of results) {
    const prompt = toPrompt(row);
    const id = prompt.promptId;
    const receipt = served.get(id);
    const planById = new Map(receipt?.plans.map(plan => [plan.planKey, plan]));
    const injection = receipt == null ? null : { ...receipt,
      plans: receipt.planIds.flatMap(id => { const plan = planById.get(id); return plan === undefined ? [] : [plan]; }),
      spores: receipt.sporeIds.flatMap(id => {
        const spore = byId.get(id);
        return spore === undefined ? [] : [{ id, observationType: spore.observationType, preview: oneLine(spore.agentLine ?? spore.content) }];
      }) };
    bodies.set(id, {
      prompt, responses: [...responses.get(id)!.rows], attachments: [...attachments.get(id)!.rows],
      plans: [...plans.get(id)!.rows], answers: [...answers.get(id)!.rows], injection, children: [],
      metrics: { tools: JSON.parse(row.tools as string), durationMs: !sourceTimestampsRecorded(CAPTURE_RULE_BUNDLES, row.agent as string | null) || row.last_reply == null ? null : Math.max(0, (row.last_reply as number) - prompt.createdAt), tokens: null },
      cursors: { responses: responses.get(id)!.cursor, attachments: attachments.get(id)!.cursor,
        plans: plans.get(id)!.cursor, answers: answers.get(id)!.cursor, children: null },
    });
  }
  return bodies;
}

/** A bounded page of steering prompts, with their bodies hydrated together. */
export async function listSteeringChildren(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<TurnChild>> {
  const children = await steeringChildPage(db, scope, sessionId, promptId, opts);
  const bodies = await readTurnBodies(db, scope, sessionId, children.rows.map(r => r.prompt_id as string));
  return steeringBodies(children, bodies);
}

async function steeringChildPage(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string, opts: { limit?: number; cursor?: string }): Promise<Page<Record<string, unknown>>> {
  const k = keyset(opts, { order: 'pb.created_at', id: 'pb.prompt_id', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const { results } = await db.prepare(`SELECT ${PROMPT_COLUMNS}, ${TOOL_CALL_COUNT} AS tool_call_count, ${CHILD_COUNT} AS child_count FROM prompt_batches pb
    WHERE pb.project_id = ? AND pb.session_id = ? AND pb.parent_prompt_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
    ORDER BY +pb.created_at ASC, pb.prompt_id ASC LIMIT ?`)
    .bind(scope.projectId, sessionId, promptId, ...k.params, k.limit + 1).all<Record<string, unknown>>();
  return page(results, k.limit, (r) => ({ createdAt: r.created_at as number, id: r.prompt_id as string }));
}

function steeringBodies(children: Page<Record<string, unknown>>, bodies: Map<string, TurnDetail>): Page<TurnChild> {
  const rows = children.rows.map(r => {
    const prompt = toPrompt(r);
    const body = bodies.get(prompt.promptId)!;
    return { prompt, responses: body.responses, responsesCursor: body.cursors.responses,
      toolCallCount: r.tool_call_count as number, childCount: r.child_count as number, body };
  });
  return { cursor: children.cursor, rows };
}

/** A turn collection's continuation, confined to the prompt's Project and session. */
export function turnCollection(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string, collection: TurnCollection, opts: { limit?: number; cursor?: string }) {
  const bounded = { ...opts, limit: Math.min(opts.limit ?? TURN_BODY_LIMIT, TURN_BODY_LIMIT), promptId };
  switch (collection) {
    case 'responses': return listChildren(db, RESPONSE_QUERY, scope, sessionId, bounded);
    case 'attachments': return listChildren(db, ATTACHMENT_QUERY, scope, sessionId, bounded);
    case 'plans': return listChildren(db, TURN_PLAN_QUERY, scope, sessionId, bounded);
    case 'answers': return listChildren(db, ANSWER_QUERY, scope, sessionId, bounded);
    case 'children': return listSteeringChildren(db, scope, sessionId, promptId, bounded);
  }
}


export interface ToolUsage { toolName: string; count: number }
export interface TurnMetrics { tools: ToolUsage[]; durationMs: number | null; tokens: null }
export interface PromptAnswer {
  id: string; createdAt: number; outcome: string; contextChars: number;
  parts: Array<{ kind: string; sporeCount?: number; planCount?: number }>;
  skipped: string[]; failures: Array<{ contributor: string; error: string; operation?: string }>;
  selection: Record<string, number>;
}
export interface TurnContext { start: boolean; subagents: number }

const ANSWER_QUERY = {
  table: 'prompt_context_answers', idColumn: 'id', orderColumn: 'created_at',
  columns: 'prompt_id, id, created_at, outcome, context_chars, parts, skipped, failures, selection',
  map: (r: Record<string, unknown>): PromptAnswer => ({
    id: r.id as string, createdAt: r.created_at as number, outcome: r.outcome as string, contextChars: r.context_chars as number,
    parts: JSON.parse(r.parts as string), skipped: JSON.parse(r.skipped as string),
    failures: JSON.parse(r.failures as string), selection: JSON.parse(r.selection as string),
  }),
};

/** Counts every stored call, independent of the page of call details. */
export async function toolUsage(db: RelationalStore, scope: ReadScope, sessionId: string, promptId?: string): Promise<ToolUsage[]> {
  const { results } = await db.prepare(toolUsageSql(promptId !== undefined))
    .bind(scope.projectId, sessionId, ...(promptId === undefined ? [] : [promptId])).all<{ tool_name: string; n: number }>();
  return results.map((r) => ({ toolName: r.tool_name, count: r.n }));
}

export function toolUsageSql(byPrompt: boolean, correlated = false): string {
  const project = correlated ? 'pb.project_id' : '?';
  const session = correlated ? 'pb.session_id' : '?';
  const prompt = correlated ? 'pb.prompt_id' : '?';
  return `SELECT tool_name, COUNT(*) AS n FROM tool_calls WHERE project_id = ${project} AND session_id = ${session} ${byPrompt ? 'AND prompt_id = ' + prompt : ''}
    GROUP BY +tool_name ORDER BY n DESC, tool_name ASC`;
}


const SUBAGENT_CONTEXT_PREFIX = 'cortex:';

/** Receipt attribution is computed once for a session, using retained identities. */
export async function sessionTurnContexts(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<Record<string, TurnContext>> {
  const [prompts, receipts, agents] = await Promise.all([
    db.prepare('SELECT prompt_id, thread_id, parent_prompt_id, origin FROM prompt_batches WHERE project_id = ? AND session_id = ? ORDER BY created_at, prompt_id')
      .bind(scope.projectId, sessionId).all<{ prompt_id: string; thread_id: string | null; parent_prompt_id: string | null; origin: string }>(),
    db.prepare("SELECT kind FROM session_injections WHERE project_id = ? AND session_id = ? AND (kind = 'cortex' OR kind LIKE 'cortex:%')")
      .bind(scope.projectId, sessionId).all<{ kind: string }>(),
    db.prepare("SELECT json_extract(payload, '$.subagentId') AS agent, json_extract(payload, '$.parentPromptId') AS parent FROM events WHERE project_id = ? AND session_id = ? AND kind = 'subagent.start'")
      .bind(scope.projectId, sessionId).all<{ agent: string; parent: string }>(),
  ]);
  const contexts: Record<string, TurnContext> = {};
  const firstByThread = new Map<string, string>();
  for (const p of prompts.results) if (p.thread_id !== null && !firstByThread.has(p.thread_id)) firstByThread.set(p.thread_id, p.prompt_id);
  const parents = new Map(agents.results.map(a => [a.agent, a.parent]));
  const first = prompts.results.find(p => p.parent_prompt_id === null && p.origin === 'user')?.prompt_id;
  const add = (id: string): TurnContext => contexts[id] ??= { start: false, subagents: 0 };
  for (const receipt of receipts.results) {
    if (receipt.kind === 'cortex') { if (first !== undefined) add(first).start = true; continue; }
    const id = receipt.kind.slice(SUBAGENT_CONTEXT_PREFIX.length);
    const prompt = firstByThread.get(id) ?? firstByThread.get(await uuidv5('thread', id)) ?? parents.get(await uuidv5('subagent', sessionId, id));
    if (prompt !== undefined && prompts.results.some(p => p.prompt_id === prompt)) add(prompt).subagents++;
  }
  return contexts;
}


function retainedIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
}
