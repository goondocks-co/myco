/**
 * A turn as the session page reads it, from the turn's own pages of the live document: the prompt, its steering
 * prompts, replies, plan appearances and tool records. What hooks recorded beside the turn (attachments, context
 * answers and the context Myco served) is read from the catalog by the prompt ids the pages name. A turn read opens at
 * most `TURN_PAGES` pages; the rest are reached through the collection cursors.
 */
import type { ContentStore, RelationalStore } from '../core/adapters.js';
import { oneLine, type PromptInjection } from '../core/injection.js';
import { listSporesByIds, MAX_SPORE_LIMIT } from '../core/spores.js';
import { sourceTimestampsRecorded } from '@goondocks/myco-shared/capture-rules';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { encodeCursor, type Page, type ReadScope } from '../read/scope.js';
import { getPlan, progressOf, type ProjectPlanRow } from '../read/plans.js';
import { receiptPlans } from '../read/view-store.js';
import { promptPlace, promptTurn } from '../read/document-catalog.js';
import { SESSION_OWNER, type DocRecord, type Page as DocPage } from './document.js';
import {
  pageCursor, promptRow, readPageCursor, responseRow, SessionDocument, toolCallRow, TURN_PAGES,
  type PageLocator, type PromptWireRow, type ResponseWireRow, type ToolCallWireRow,
} from './session-pages.js';

/** Rows each hook collection carries before its continuation. */
const HOOK_ROWS = 50;
/** Failed calls and changed files a turn's tool summary lists before it only counts. */
const SUMMARY_FAILURES = 20;
const SUMMARY_FILES = 50;

export const TURN_COLLECTIONS = ['responses', 'attachments', 'plans', 'children', 'answers'] as const;
export type TurnCollection = (typeof TURN_COLLECTIONS)[number];

interface Located { record: DocRecord; at: PageLocator }

export interface ToolUsage { toolName: string; count: number }
/**
 * A prompt's tool calls in brief: counts by tool, every failure up to a bound, the files changed and the Myco calls.
 * `complete` is false when the turn has pages the read did not open: the counts then cover only the calls it read.
 */
export interface ToolSummary {
  complete: boolean;
  total: number;
  failed: number;
  byTool: ToolUsage[];
  failures: ToolCallWireRow[];
  files: string[];
  myco: { tool: string; op: string | null; count: number; failed: number }[];
}
export interface PlanAppearanceRow {
  planKey: string; promptId: string | null; title: string | null; status: string; content: string | null; blobKey: string | null;
  originPath: string | null; progress: string; updatedBy: string | null; createdAt: number; updatedAt: number; orderedAt: number;
  locator: PageLocator;
}
export interface AttachmentRow {
  attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null;
  createdAt: number; orderedAt: number;
}
export interface PromptAnswer {
  id: string; createdAt: number; outcome: string; contextChars: number; parts: unknown[]; skipped: string[]; failures: unknown[];
  selection: Record<string, number>;
}
export interface DocumentTurnDetail {
  prompt: PromptWireRow;
  responses: ResponseWireRow[];
  attachments: AttachmentRow[];
  plans: PlanAppearanceRow[];
  injection: (PromptInjection & { planIds: string[]; plans: { planKey: string; title: string | null }[] }) | null;
  metrics: { tools: ToolUsage[]; durationMs: number | null; tokens: null };
  tools: ToolSummary;
  answers: PromptAnswer[];
  children: DocumentTurnChild[];
  cursors: Record<TurnCollection, string | null>;
}
export interface DocumentTurnChild {
  prompt: PromptWireRow; responses: ResponseWireRow[]; toolCallCount: number; responsesCursor: string | null;
  body: DocumentTurnDetail; childCount: number;
}

const located = (pages: readonly DocPage[], generation: number): Located[] =>
  pages.flatMap((page) => page.records.map((record) => ({ record, at: { generation, owner: page.owner, page: page.page } })));

/** Summarizes the tool records of one prompt; `complete` says whether they are all of its calls. */
export function toolSummary(tools: readonly Located[], complete: boolean): ToolSummary {
  const byTool = new Map<string, number>();
  const myco = new Map<string, { tool: string; op: string | null; count: number; failed: number }>();
  const files = new Set<string>();
  const failures: ToolCallWireRow[] = [];
  let failed = 0;
  for (const { record, at } of tools) {
    const row = toolCallRow(record, at);
    byTool.set(row.toolName, (byTool.get(row.toolName) ?? 0) + 1);
    if (!row.success) {
      failed += 1;
      if (failures.length < SUMMARY_FAILURES) failures.push(row);
    }
    if (row.mycoTool !== null) {
      const key = `${row.mycoTool}\u0000${row.mycoOp ?? ''}`;
      const held = myco.get(key) ?? { tool: row.mycoTool, op: row.mycoOp, count: 0, failed: 0 };
      held.count += 1;
      if (!row.success) held.failed += 1;
      myco.set(key, held);
    }
    for (const path of Array.isArray(record.files_affected) ? record.files_affected : []) {
      if (typeof path === 'string' && files.size < SUMMARY_FILES) files.add(path);
    }
  }
  return {
    complete, total: tools.length, failed, failures, files: [...files], myco: [...myco.values()],
    byTool: [...byTool].map(([toolName, count]) => ({ toolName, count })).sort((a, b) => b.count - a.count || (a.toolName < b.toolName ? -1 : 1)),
  };
}

/**
 * Each prompt's first page of a hook collection, read in its full order up to its row `HOOK_ROWS + 1`, so the statement
 * reads no further into a prompt's rows than its page and the row that shows another follows.
 */
const hookPage = (table: string, columns: string, id: string) => {
  const nth = (column: string) => `(SELECT x.${column} FROM ${table} x WHERE x.project_id = ?1 AND x.session_id = ?2 AND x.prompt_id = j.value
      ORDER BY x.created_at, x.${id} LIMIT 1 OFFSET ${HOOK_ROWS})`;
  return `WITH b AS (SELECT j.value AS prompt_id, COALESCE(${nth('created_at')}, ${Number.MAX_SAFE_INTEGER}) AS at, COALESCE(${nth(id)}, '') AS id
      FROM json_each(?3) j)
  SELECT ${columns} FROM b CROSS JOIN ${table} r INDEXED BY idx_${table}_prompt_order
    ON r.project_id = ?1 AND r.session_id = ?2 AND r.prompt_id = b.prompt_id AND (r.created_at, r.${id}) <= (b.at, b.id)
  ORDER BY r.prompt_id, r.created_at, r.${id}`;
};

/** The first page of attachments and context answers recorded for each of these prompts, and the context last served for each. */
async function hookRecords(db: RelationalStore, scope: ReadScope, sessionId: string, promptIds: readonly string[]) {
  const ids = JSON.stringify(promptIds);
  const [attachments, answers, receipts] = await db.batch([
    db.prepare(hookPage('attachments', 'r.attachment_id, r.prompt_id, r.blob_key, r.media_type, r.byte_size, r.description, r.created_at', 'attachment_id'))
      .bind(scope.projectId, sessionId, ids),
    db.prepare(hookPage('prompt_context_answers', 'r.id, r.prompt_id, r.created_at, r.outcome, r.context_chars, r.parts, r.skipped, r.failures, r.selection', 'id'))
      .bind(scope.projectId, sessionId, ids),
    db.prepare(`SELECT i.delivered_prompt_id AS prompt_id, i.id, i.spore_ids, i.created_at, COALESCE(i.plan_ids, '[]') AS plan_ids
      FROM json_each(?3) j CROSS JOIN spore_injections i ON i.project_id = ?1 AND i.session_id = ?2
        AND i.id = (SELECT x.id FROM spore_injections x INDEXED BY idx_spore_injections_delivered_at
          WHERE x.project_id = ?1 AND x.session_id = ?2 AND x.delivered_prompt_id = j.value ORDER BY x.created_at DESC LIMIT 1)`)
      .bind(scope.projectId, sessionId, ids),
  ]);
  const grouped = <T>(rows: readonly Record<string, unknown>[], map: (row: Record<string, unknown>) => T) => {
    const out = new Map<string, { rows: T[]; cursor: string | null; last: Record<string, unknown> | null }>(promptIds.map((id) => [id, { rows: [], cursor: null, last: null }]));
    for (const row of rows) {
      const held = out.get(String(row.prompt_id))!;
      if (held.rows.length < HOOK_ROWS) { held.rows.push(map(row)); held.last = row; }
      else if (held.cursor === null) held.cursor = encodeCursor(Number(held.last!.created_at), String(held.last!.attachment_id ?? held.last!.id));
    }
    return out;
  };
  const served = new Map<string, { receiptId: string; sporeIds: string[]; planIds: string[]; createdAt: number }>();
  for (const row of receipts!.results as Record<string, unknown>[]) {
    const ids = (raw: unknown): string[] => {
      try { const parsed: unknown = JSON.parse(String(raw)); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
    };
    served.set(String(row.prompt_id), { receiptId: String(row.id), sporeIds: ids(row.spore_ids), planIds: ids(row.plan_ids), createdAt: Number(row.created_at) });
  }
  const plansByReceipt = await receiptPlans(db, scope, [...served.values()].map((r) => ({ receiptId: r.receiptId, planIds: r.planIds })));
  const sporeIds = [...new Set([...served.values()].flatMap((r) => r.sporeIds))];
  const spores = [];
  for (let offset = 0; offset < sporeIds.length; offset += MAX_SPORE_LIMIT) spores.push(...await listSporesByIds(db, scope, sporeIds.slice(offset, offset + MAX_SPORE_LIMIT)));
  const sporeById = new Map(spores.map((spore) => [spore.id, spore]));
  const injection = (promptId: string): DocumentTurnDetail['injection'] => {
    const receipt = served.get(promptId);
    if (receipt === undefined) return null;
    const planById = new Map((plansByReceipt.get(receipt.receiptId) ?? []).map((plan) => [plan.planKey, { planKey: plan.planKey, title: plan.title }]));
    return {
      sporeIds: receipt.sporeIds, planIds: receipt.planIds, createdAt: receipt.createdAt,
      plans: receipt.planIds.flatMap((id) => { const plan = planById.get(id); return plan === undefined ? [] : [plan]; }),
      spores: receipt.sporeIds.flatMap((id) => {
        const spore = sporeById.get(id);
        return spore === undefined ? [] : [{ id, observationType: spore.observationType, preview: oneLine(spore.agentLine ?? spore.content) }];
      }),
    };
  };
  return {
    attachments: grouped(attachments!.results as Record<string, unknown>[], (r): AttachmentRow => ({
      attachmentId: String(r.attachment_id), promptId: (r.prompt_id as string | null) ?? null, blobKey: String(r.blob_key),
      mediaType: String(r.media_type), byteSize: Number(r.byte_size), description: (r.description as string | null) ?? null,
      createdAt: Number(r.created_at), orderedAt: Number(r.created_at),
    })),
    answers: grouped(answers!.results as Record<string, unknown>[], (r): PromptAnswer => ({
      id: String(r.id), createdAt: Number(r.created_at), outcome: String(r.outcome), contextChars: Number(r.context_chars),
      parts: JSON.parse(String(r.parts)) as unknown[], skipped: JSON.parse(String(r.skipped)) as string[],
      failures: JSON.parse(String(r.failures)) as unknown[], selection: JSON.parse(String(r.selection)) as Record<string, number>,
    })),
    injection,
  };
}

/** The editorial fields of the canonical plans these appearances belong to. */
async function canonicalPlans(db: RelationalStore, scope: ReadScope, keys: readonly string[]) {
  const out = new Map<string, ProjectPlanRow>();
  for (const key of keys) {
    const plan = await getPlan(db, scope, key);
    if (plan !== null && 'updatedAt' in plan) out.set(key, plan);
  }
  return out;
}

/** The plans a prompt's appearances name, as their canonical rows stand; a plan with no canonical row shows its latest appearance. */
function planRows(appearances: readonly Located[], canonical: Awaited<ReturnType<typeof canonicalPlans>>): PlanAppearanceRow[] {
  const latest = new Map<string, Located>();
  for (const held of appearances) {
    const key = String(held.record.plan_key ?? held.record.id);
    const prior = latest.get(key);
    if (prior === undefined || prior.record.created_at <= held.record.created_at) latest.set(key, held);
  }
  return [...latest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([planKey, { record, at }]) => {
    const plan = canonical.get(planKey);
    if (plan !== undefined) return { ...plan, promptId: record.prompt_id, orderedAt: record.created_at, locator: at };
    const content = typeof record.content === 'string' ? record.content : null;
    return {
      planKey, promptId: record.prompt_id, title: typeof record.title === 'string' ? record.title : null,
      status: String(record.status ?? 'active'), content, blobKey: record.bodies?.content?.digest ?? null,
      originPath: typeof record.origin_path === 'string' ? record.origin_path : null, progress: progressOf(content),
      updatedBy: null, createdAt: record.created_at, updatedAt: record.created_at, orderedAt: record.created_at, locator: at,
    };
  });
}

/** A run of a turn's pages as one read opened them: its records, and the page after them when the turn has more. */
interface TurnWindow { generation: number; records: Located[]; next: number | null }

/**
 * Builds the body of any prompt the window holds, its steering prompts nested within it, from the window's records and
 * the hook records of every prompt in it. Collections the window does not finish continue from the page after it.
 */
async function windowBodies(env: ContentStore, scope: ReadScope, sessionId: string, window: TurnWindow) {
  const prompts = window.records.filter(({ record }) => record.k === 'prompt');
  const [hooks, agent, canonical] = await Promise.all([
    hookRecords(env.db, scope, sessionId, prompts.map(({ record }) => record.id)),
    env.db.prepare(`SELECT agent FROM sessions WHERE project_id = ? AND session_id = ?`).bind(scope.projectId, sessionId).first<{ agent: string | null }>(),
    canonicalPlans(env.db, scope, [...new Set(window.records.filter(({ record }) => record.k === 'plan').map(({ record }) => String(record.plan_key ?? record.id)))]),
  ]);
  const timed = sourceTimestampsRecorded(CAPTURE_RULE_BUNDLES, agent?.agent ?? null);
  const more = window.next === null ? null : pageCursor(window.generation, window.next);
  const of = (kind: DocRecord['k'], prompt: string) => window.records.filter(({ record }) => record.k === kind && record.prompt_id === prompt);
  const body = (held: Located, depth: number): DocumentTurnDetail => {
    const id = held.record.id;
    const tools = of('tool', id);
    const replies = of('reply', id);
    const summary = toolSummary(tools, window.next === null);
    const lastReply = replies.reduce<number | null>((at, { record }) => Math.max(at ?? 0, record.created_at), null);
    const children = depth > 8 ? [] : prompts.filter(({ record }) => record.parent_prompt_id === id).map((child) => turnChild(body(child, depth + 1)));
    const attachments = hooks.attachments.get(id) ?? { rows: [], cursor: null };
    const answers = hooks.answers.get(id) ?? { rows: [], cursor: null };
    return {
      prompt: promptRow(held.record, held.at), responses: replies.map(({ record, at }) => responseRow(record, at)),
      attachments: attachments.rows, plans: planRows(of('plan', id), canonical), injection: hooks.injection(id),
      metrics: { tools: summary.byTool, durationMs: !timed || lastReply === null ? null : Math.max(0, lastReply - held.record.created_at), tokens: null },
      tools: summary, answers: answers.rows, children,
      cursors: { responses: more, plans: more, children: more, attachments: attachments.cursor, answers: answers.cursor },
    };
  };
  return { prompts, body };
}

const turnChild = (body: DocumentTurnDetail): DocumentTurnChild => ({
  prompt: body.prompt, responses: body.responses, toolCallCount: body.tools.total, responsesCursor: body.cursors.responses, body,
  childCount: body.children.length,
});

/**
 * One prompt's body, or null when no prompt of that id sits in the session's live document. The read opens
 * `TURN_PAGES` of its turn's pages from the page the catalog records for the prompt's record, or from the turn's first
 * page when it records none or found no page holding it; the rest are reached through the collection cursors.
 */
export async function documentTurnDetail(env: ContentStore, scope: ReadScope, sessionId: string, promptId: string): Promise<DocumentTurnDetail | null> {
  const place = await promptPlace(env.db, scope, sessionId, promptId);
  if (place === undefined) return null;
  const doc = await SessionDocument.open(env, scope.projectId, sessionId);
  if (doc === null) return null;
  const from = place.page !== null && place.page >= 0 ? place.page : 0;
  const read = await doc.ownerPages(place.turn ?? SESSION_OWNER, from, TURN_PAGES);
  const records = located(read.pages, doc.generation);
  const top = records.find(({ record }) => record.k === 'prompt' && record.id === promptId);
  if (top === undefined) return null;
  return (await windowBodies(env, scope, sessionId, { generation: doc.generation, records, next: read.more ? from + read.pages.length : null })).body(top, 0);
}

/** One prompt's tool calls in source order, a turn's pages at a time; the cursor names the next page. */
export async function documentPromptTools(env: ContentStore, scope: ReadScope, sessionId: string, promptId: string,
  cursor: string | undefined): Promise<Page<ToolCallWireRow> | 'stale' | null> {
  const turn = await promptTurn(env.db, scope, sessionId, promptId);
  if (turn === undefined) return null;
  const doc = await SessionDocument.open(env, scope.projectId, sessionId);
  if (doc === null) return null;
  const at = readPageCursor(cursor, doc.generation);
  if (at === null || at === 'stale') return at;
  const from = Math.max(0, at.at);
  const read = await doc.ownerPages(turn ?? SESSION_OWNER, from, TURN_PAGES);
  const rows = located(read.pages, doc.generation).filter(({ record }) => record.k === 'tool' && record.prompt_id === promptId)
    .map(({ record, at: where }) => toolCallRow(record, where));
  return { rows, cursor: read.more ? pageCursor(doc.generation, from + read.pages.length) : null };
}

/** A turn collection's continuation: later pages of the turn for its records, or the next hook rows. */
export async function documentTurnCollection(env: ContentStore, scope: ReadScope, sessionId: string, promptId: string,
  collection: TurnCollection, cursor: string | undefined): Promise<Page<unknown> | 'stale' | null> {
  if (collection === 'attachments' || collection === 'answers') return hookCollection(env.db, scope, sessionId, promptId, collection, cursor);
  const turn = await promptTurn(env.db, scope, sessionId, promptId);
  if (turn === undefined) return null;
  const doc = await SessionDocument.open(env, scope.projectId, sessionId);
  if (doc === null) return null;
  const at = readPageCursor(cursor, doc.generation);
  if (at === null || at === 'stale') return at;
  const from = Math.max(0, at.at);
  const read = await doc.ownerPages(turn ?? SESSION_OWNER, from, TURN_PAGES);
  const records = located(read.pages, doc.generation);
  const next = read.more ? pageCursor(doc.generation, from + read.pages.length) : null;
  if (collection === 'responses') {
    return { rows: records.filter(({ record }) => record.k === 'reply' && record.prompt_id === promptId).map(({ record, at: where }) => responseRow(record, where)), cursor: next };
  }
  if (collection === 'plans') {
    const appearances = records.filter(({ record }) => record.k === 'plan' && record.prompt_id === promptId);
    const canonical = await canonicalPlans(env.db, scope, [...new Set(appearances.map(({ record }) => String(record.plan_key ?? record.id)))]);
    return { rows: planRows(appearances, canonical), cursor: next };
  }
  const window = await windowBodies(env, scope, sessionId, { generation: doc.generation, records, next: read.more ? from + read.pages.length : null });
  return { rows: window.prompts.filter(({ record }) => record.parent_prompt_id === promptId).map((child) => turnChild(window.body(child, 1))), cursor: next };
}

async function hookCollection(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string, collection: 'attachments' | 'answers',
  cursor: string | undefined): Promise<Page<unknown> | null> {
  const after = cursor === undefined ? null : /^(-?[0-9]+):(.+)$/.exec(cursor);
  if (cursor !== undefined && after === null) return null;
  const keyed = after === null ? '' : `AND (created_at, ${collection === 'attachments' ? 'attachment_id' : 'id'}) > (?, ?)`;
  const keys = after === null ? [] : [Number(after[1]), after[2]];
  const sql = collection === 'attachments'
    ? `SELECT attachment_id, prompt_id, blob_key, media_type, byte_size, description, created_at FROM attachments INDEXED BY idx_attachments_prompt_order
       WHERE project_id = ? AND session_id = ? AND prompt_id = ? ${keyed} ORDER BY created_at, attachment_id LIMIT ?`
    : `SELECT id, prompt_id, created_at, outcome, context_chars, parts, skipped, failures, selection FROM prompt_context_answers INDEXED BY idx_prompt_context_answers_prompt_order
       WHERE project_id = ? AND session_id = ? AND prompt_id = ? ${keyed} ORDER BY created_at, id LIMIT ?`;
  const { results } = await db.prepare(sql).bind(scope.projectId, sessionId, promptId, ...keys, HOOK_ROWS + 1).all<Record<string, unknown>>();
  const shown = results.slice(0, HOOK_ROWS);
  const last = shown.at(-1);
  const next = results.length > HOOK_ROWS && last !== undefined ? encodeCursor(Number(last.created_at), String(last.attachment_id ?? last.id)) : null;
  const rows = collection === 'attachments'
    ? shown.map((r) => ({ attachmentId: String(r.attachment_id), promptId: (r.prompt_id as string | null) ?? null, blobKey: String(r.blob_key),
      mediaType: String(r.media_type), byteSize: Number(r.byte_size), description: (r.description as string | null) ?? null,
      createdAt: Number(r.created_at), orderedAt: Number(r.created_at) }))
    : shown.map((r) => ({ id: String(r.id), createdAt: Number(r.created_at), outcome: String(r.outcome), contextChars: Number(r.context_chars),
      parts: JSON.parse(String(r.parts)) as unknown[], skipped: JSON.parse(String(r.skipped)) as string[],
      failures: JSON.parse(String(r.failures)) as unknown[], selection: JSON.parse(String(r.selection)) as Record<string, number> }));
  return { rows, cursor: next };
}

export interface UnplacedDocumentRecord { key: string; kind: string; id: string; promptHint: string | null; label: string; createdAt: number; failed: boolean }

/** The records no turn holds, from the session's own pages in page order, a few pages a request; the cursor names the next page. */
export async function documentUnplacedRecords(env: ContentStore, scope: ReadScope, sessionId: string,
  cursor: string | undefined): Promise<Page<UnplacedDocumentRecord> | 'stale' | null> {
  const doc = await SessionDocument.open(env, scope.projectId, sessionId);
  if (doc === null) return { rows: [], cursor: null };
  const at = readPageCursor(cursor, doc.generation);
  if (at === null || at === 'stale') return at;
  const from = Math.max(0, at.at);
  const read = await doc.ownerPages(SESSION_OWNER, from, TURN_PAGES);
  const rows = located(read.pages, doc.generation).map(({ record }): UnplacedDocumentRecord => {
    const hint = record.k === 'prompt' ? (typeof record.parent_prompt_id === 'string' ? record.parent_prompt_id : null) : record.prompt_id;
    const label = record.k === 'tool' ? String(record.tool_name ?? 'Tool call') : record.k === 'reply' ? 'Reply'
      : record.k === 'plan' ? (typeof record.title === 'string' ? record.title : 'Plan') : 'Prompt';
    return { key: `${record.k}:${record.id}`, kind: record.k, id: record.id, promptHint: hint, label, createdAt: record.created_at, failed: record.k === 'tool' && record.success === 0 };
  });
  return { rows, cursor: read.more ? pageCursor(doc.generation, from + read.pages.length) : null };
}
