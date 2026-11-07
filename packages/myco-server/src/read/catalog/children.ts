import type { RelationalStore as children_import_RelationalStore } from "../../core/adapters.js";
import { sessionMaterialReadySql as children_import_sessionMaterialReadySql } from "../material-readiness.js";
import { titlingClaimAvailableSql as children_import_titlingClaimAvailableSql } from "../material-readiness.js";
import { notTombstonedSql as children_import_notTombstonedSql } from "../../db/session-read-model.js";
import { titleRunInFlightSql as children_import_titleRunInFlightSql } from "../../db/session-read-model.js";
import { TITLING_MAX_ATTEMPTS as children_import_TITLING_MAX_ATTEMPTS } from "../../constants.js";
import { containsPattern as children_import_containsPattern } from "../scope.js";
import { keyset as children_import_keyset } from "../scope.js";
import { page as children_import_page } from "../scope.js";
import type { Page as children_import_Page } from "../scope.js";
import type { ReadScope as children_import_ReadScope } from "../scope.js";
import { hook_placement_hookPlacementSql, hook_placement_placedHintSql } from './hook-placement.js';
import { plans_progressOf } from './plans.js';
import { queryRows } from './shared.js';

/** A child projection read: its table, selected columns, order expression and tie-breaking identity. */
interface children_ChildQuery<T> {
  table: string;
  index?: string;
  promptHint?: string;
  columns: string;
  idColumn: string;
  /** The numeric ordering expression paired with the identity in a page cursor. */
  orderColumn: string;
  map: (row: Record<string, unknown>) => T;
}

/** Paging plus, for the tables that carry one, the prompt whose children the page is narrowed to; `idx_tool_calls_prompt` and `idx_attachments_prompt` serve the narrowed order. */
interface children_ChildOptions { limit?: number; cursor?: string; promptId?: string }

/** Conditions a child read adds past the session scope, each a SQL term with the values it binds. */
interface children_ChildFilter { sql: string; params: readonly unknown[] }

function children_childColumns<T>(query: children_ChildQuery<T>): string {
  if (query.promptHint === undefined) return query.columns;
  return `${hook_placement_placedHintSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` })} AS prompt_id, ${query.columns}`;
}

/** `planKey` is the plan's identity in this table (its primary key), not a session-scoped id. `createdAt` is the plan's first capture; `orderedAt` carries the `updated_at` this listing pages over. */
interface children_PlanRow { planKey: string; promptId: string | null; title: string | null; status: string; content: string | null; blobKey: string | null; originPath: string | null; progress: string; updatedBy: string | null; createdAt: number; updatedAt: number; orderedAt: number }

/** `promptId` names the session prompt the attachment's captured hint resolves to; an unplaced attachment carries null. */
interface children_AttachmentRow { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number; orderedAt: number }

/**
 * A record of what Myco served the session as a whole: a session-level block (`kind` names it: `cortex` for the start,
 * `cortex:<agent>` for a sub-agent's, `plan-nudge`), or context no named prompt received (`kind` is `context:<row
 * id>`): an answer, or a receipt no answer names, which outlives the answers' retention. `delivery` says whether it
 * reached the agent with no matching prompt in this session, or has no reported delivery.
 */
interface children_ContextInjectionRow { kind: string; createdAt: number; orderedAt: number; delivery: 'unnamed_prompt' | 'not_delivered' | null }

/** The prefix of an answer row's `kind` in the session's context records. */
const children_SESSION_ANSWER_KIND_PREFIX = 'context:';

const children_CONTEXT_INJECTION_QUERY: children_ChildQuery<Omit<children_ContextInjectionRow, 'orderedAt'>> = {
  table: `(SELECT project_id, session_id, kind, created_at, NULL AS delivery FROM session_injections
     UNION ALL
     SELECT project_id, session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || id AS kind, created_at,
       CASE WHEN delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM prompt_context_answers WHERE outcome = 'served' AND NOT ${hook_placement_hookPlacementSql({ project: 'prompt_context_answers.project_id', session: 'prompt_context_answers.session_id', prompt: 'prompt_context_answers.delivered_prompt_id' })}
     UNION ALL
     SELECT r.project_id, r.session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || r.id AS kind, r.created_at,
       CASE WHEN r.delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM spore_injections r WHERE NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.delivered_prompt_id' })}
         AND NOT EXISTS (SELECT 1 FROM prompt_context_answers a
                          WHERE a.project_id = r.project_id AND a.session_id = r.session_id AND a.receipt_id = r.id))`,
  columns: 'kind, created_at, delivery', idColumn: 'kind', orderColumn: 'created_at',
  map: (r) => ({ kind: r.kind as string, createdAt: r.created_at as number, delivery: (r.delivery as children_ContextInjectionRow['delivery']) ?? null }),
};

/** Plans order by `updated_at` — the column `idx_plans_session` indexes — and are keyed by `plan_key`. */
const children_PLAN_QUERY: children_ChildQuery<Omit<children_PlanRow, 'orderedAt'>> = {
  table: 'plans', index: 'idx_plans_session', columns: 'plan_key, prompt_id, title, status, content, blob_key, origin_path, updated_by, created_at, updated_at', idColumn: 'plan_key', orderColumn: 'updated_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    planKey: r.plan_key as string,
    promptId: (r.prompt_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    status: r.status as string,
    content: (r.content as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    originPath: (r.origin_path as string | null) ?? null,
    progress: plans_progressOf((r.content as string | null) ?? null),
    updatedBy: (r.updated_by as string | null) ?? null,
  }),
};

const children_ATTACHMENT_QUERY: children_ChildQuery<Omit<children_AttachmentRow, 'orderedAt'>> = {
  table: 'attachments', promptHint: 'prompt_id', columns: 'attachment_id, blob_key, media_type, byte_size, description, created_at', idColumn: 'attachment_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    attachmentId: r.attachment_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    blobKey: r.blob_key as string,
    mediaType: r.media_type as string,
    byteSize: r.byte_size as number,
    description: (r.description as string | null) ?? null,
  }),
};

/** Paging alone, for a table with no prompt column to narrow by. */
type children_PagingOptions = Pick<children_ChildOptions, 'limit' | 'cursor'>;

const children_listContextInjections = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_PagingOptions) => children_listChildren(db, children_CONTEXT_INJECTION_QUERY, scope, sessionId, opts);

/** A session's plans narrowed to one status and to a text its title contains; the terms leave `idx_plans_session` serving the scope and the order. */
interface children_PlanChildOptions extends children_ChildOptions { status?: string; q?: string }

function children_listPlans(db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts: children_PlanChildOptions = {}) {
  const { status, q, ...paging } = opts;
  const filters: children_ChildFilter[] = [];
  if (status !== undefined) filters.push({ sql: 'status = ?', params: [status] });
  const text = q?.trim() ?? '';
  if (text !== '') filters.push({ sql: `title LIKE ? ESCAPE '\\'`, params: [children_import_containsPattern(text)] });
  return children_listChildren(db, children_PLAN_QUERY, scope, sessionId, paging, filters);
}

const children_listAttachments = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_ChildOptions) => children_listChildren(db, children_ATTACHMENT_QUERY, scope, sessionId, opts);

/** The session's live document holds a user prompt for the titling material. */
const children_sessionHasMaterialSql = (alias: string): string => `EXISTS (SELECT 1 FROM session_documents d
  WHERE d.project_id = ${alias}.project_id AND d.session_id = ${alias}.session_id AND d.state = 'live' AND d.user_prompts > 0)`;

/**
 * Live end requests not yet attempted, with ready inline material, from
 * sessions whose member last sent anything at or before `settledBefore`;
 * oldest request first.
 */
async function children_listReadyTitleSessions(db: children_import_RelationalStore, limit: number, settledBefore: number): Promise<{ projectId: string; sessionId: string }[]> {
  const { results } = await db.prepare(`SELECT s.project_id AS projectId, s.session_id AS sessionId FROM sessions s
    WHERE s.titling_requested_at IS NOT NULL AND s.ended_at IS NOT NULL AND s.titled_at IS NULL AND s.title IS NULL
      AND s.last_received_at <= ?
      AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND ${children_sessionHasMaterialSql('s')}
    ORDER BY s.titling_requested_at, s.project_id, s.session_id LIMIT ?`).bind(settledBefore, limit).all<{ projectId: string; sessionId: string }>();
  return results;
}

/** A session every transcript of which arrived through the import channel; a session with no transcript, or with a live one, is not imported. */
const children_importedSessionSql = (alias: string): string => `EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id)
  AND NOT EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id AND t.imported_at IS NULL)`;

/** A session the titling convergence may take next: a first title (`claim`) or a refresh of the one standing (`refresh`), with the instant its recency is ranked by. */
interface children_TitleCandidate { projectId: string; sessionId: string; mode: 'claim' | 'refresh'; at: number }

/** The instants that decide which sessions the convergence may take, and how ready each must be. */
interface children_TitleCandidateWindow {
  /** The latest stamp an earlier attempt may carry for a retry. */
  retryBefore: number;
  /** A session still open whose last receipt is at or before this counts as ended. */
  idleBefore: number;
  /** A session whose latest activity or end is at or after this is fresh work; an earlier one is backlog, and takes no refresh. */
  freshAfter: number;
  /** A titled session is due a refresh only when its last titling stamp is at or before this. */
  refreshBefore: number;
  /** The user prompts a titled session takes after the material of its standing title before it is due a refresh. */
  refreshPrompts: number;
  /** Whether wholly imported sessions are admitted. */
  imported: boolean;
}

const children_claimableSql = `${children_import_titlingClaimAvailableSql('s')} AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND ${children_sessionHasMaterialSql('s')}`;

const children_importedAdmittedSql = `(? = 1 OR s.titling_requested_at IS NOT NULL OR NOT (${children_importedSessionSql('s')}))`;

/**
 * The ended, untitled sessions the titling convergence may claim: every
 * transcript parsed, inline material, and an available claim. A live end
 * request's first attempt is `session-titling`'s and is left out.
 */
const children_ENDED_UNTITLED_SQL = `FROM sessions s
    WHERE s.ended_at IS NOT NULL AND s.title IS NULL AND NOT (s.titled_at IS NULL AND s.titling_requested_at IS NOT NULL)
      AND ${children_claimableSql} AND ${children_importedAdmittedSql}`;

/** The open, untitled sessions whose last receipt is at or before `idleBefore`: ended for titling, not for the session. */
const children_IDLE_UNTITLED_SQL = `FROM sessions s
    WHERE s.ended_at IS NULL AND s.title IS NULL AND s.last_received_at <= ?
      AND ${children_claimableSql} AND ${children_importedAdmittedSql}`;

/**
 * Titled sessions, open or ended, with activity after the material of their standing title, due a refresh: stamped at or before the
 * bound, no title run of the session in flight, and its document holding at least a number of user prompts beyond those
 * the standing title recorded. A refresh that closed without a write leaves that record where it was, so its session stays due.
 * Binds: the recency bound, the stamp bound, then the prompt number.
 */
const children_REFRESH_DUE_SQL = `FROM sessions s
    WHERE s.title IS NOT NULL AND s.last_received_at >= ? AND s.last_received_at > COALESCE(s.title_material_at, s.titled_at) AND s.titled_at <= ?
      AND ${children_import_notTombstonedSql('s')} AND ${children_import_sessionMaterialReadySql('s')} AND NOT ${children_import_titleRunInFlightSql('s')}
      AND (SELECT d.user_prompts - COALESCE(d.titled_user_prompts, 0) FROM session_documents d
        WHERE d.project_id = s.project_id AND d.session_id = s.session_id AND d.state = 'live') >= ?`;

/** Candidates in the order the convergence takes them: first titles before refreshes, and fresh work before backlog within each. */
interface children_TitleCandidates { freshClaims: children_TitleCandidate[]; freshRefreshes: children_TitleCandidate[]; backlogClaims: children_TitleCandidate[] }

/** The page of one kind of candidate, ordered by the column its partial index holds. */
async function children_candidatePage(db: children_import_RelationalStore, mode: children_TitleCandidate['mode'], sql: string, at: string, order: string, binds: readonly unknown[], limit: number): Promise<children_TitleCandidate[]> {
  const { results } = await db.prepare(`SELECT s.project_id AS projectId, s.session_id AS sessionId, ${at} AS at ${sql} ORDER BY ${order} LIMIT ?`)
    .bind(...binds, limit).all<{ projectId: string; sessionId: string; at: number }>();
  return results.map((r) => ({ ...r, mode }));
}

/**
 * Up to `limit` candidates of each kind, newest first: first titles of sessions ended or gone quiet within the freshness
 * window and outside it, and refreshes of sessions active within it. Each read is bounded by its own partial index and by
 * the cohort's recency bound before its limit, so older work never hides newer work and no page sorts a backlog.
 */
async function children_listTitleCandidates(db: children_import_RelationalStore, window: children_TitleCandidateWindow, limit: number): Promise<children_TitleCandidates> {
  const imported = window.imported ? 1 : 0;
  const ended = (side: 'fresh' | 'backlog') => children_candidatePage(db, 'claim', `${children_ENDED_UNTITLED_SQL} AND s.ended_at ${side === 'fresh' ? '>=' : '<'} ?`, 's.ended_at',
    's.ended_at DESC, s.project_id, s.session_id', [window.retryBefore, imported, window.freshAfter], limit);
  const idle = (side: 'fresh' | 'backlog') => children_candidatePage(db, 'claim', `${children_IDLE_UNTITLED_SQL} AND s.last_received_at ${side === 'fresh' ? '>=' : '<'} ?`, 's.last_received_at',
    's.last_received_at DESC, s.project_id, s.session_id', [window.idleBefore, window.retryBefore, imported, window.freshAfter], limit);
  const refresh = () => children_candidatePage(db, 'refresh', children_REFRESH_DUE_SQL, 's.last_received_at', 's.last_received_at DESC, s.project_id, s.session_id',
    [window.freshAfter, window.refreshBefore, window.refreshPrompts], limit);
  const [endedFresh, idleFresh, endedBacklog, idleBacklog, freshRefreshes] = await Promise.all([ended('fresh'), idle('fresh'), ended('backlog'), idle('backlog'), refresh()]);
  const newest = (rows: children_TitleCandidate[]) => rows.sort((a, b) => b.at - a.at || a.projectId.localeCompare(b.projectId) || a.sessionId.localeCompare(b.sessionId)).slice(0, limit);
  return { freshClaims: newest([...endedFresh, ...idleFresh]), freshRefreshes, backlogClaims: newest([...endedBacklog, ...idleBacklog]) };
}

/** The ended or quiet, untitled sessions a statement selects, split by whether their own capture owes the title or the backfill switch admits it. */
async function children_countOwed(db: children_import_RelationalStore, selection: string, binds: readonly unknown[]): Promise<{ live: number; imported: number }> {
  const row = await db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(s.titling_requested_at IS NULL AND ${children_importedSessionSql('s')}), 0) AS imported ${selection}`)
    .bind(...binds).first<{ total: number; imported: number }>();
  const imported = row?.imported ?? 0;
  return { live: (row?.total ?? 0) - imported, imported };
}

/** What the titling convergence has left: sessions whose own capture owes them a title (ended, or gone quiet), and wholly imported sessions the backfill switch admits. */
async function children_countConvergenceTitleSessions(db: children_import_RelationalStore, retryBefore: number, idleBefore: number): Promise<{ live: number; imported: number }> {
  const [ended, quiet] = await Promise.all([
    children_countOwed(db, children_ENDED_UNTITLED_SQL, [retryBefore, 1]),
    children_countOwed(db, children_IDLE_UNTITLED_SQL, [idleBefore, retryBefore, 1]),
  ]);
  return { live: ended.live + quiet.live, imported: ended.imported + quiet.imported };
}

/** Why an ended session carries no title yet, in the order a reader can act on it. */
type children_UntitledReason = 'capture_pending' | 'no_material' | 'in_progress' | 'stopped' | 'imported' | 'waiting';

/** Why an ended session is untitled; null for a titled or open session, or one the project does not hold. */
async function children_untitledReason(db: children_import_RelationalStore, projectId: string, sessionId: string): Promise<children_UntitledReason | null> {
  const row = await db.prepare(`SELECT CASE WHEN s.title IS NOT NULL OR s.ended_at IS NULL THEN NULL
      WHEN NOT ${children_import_sessionMaterialReadySql('s')} THEN 'capture_pending'
      WHEN NOT ${children_sessionHasMaterialSql('s')} THEN 'no_material'
      WHEN ${children_import_titleRunInFlightSql('s')} THEN 'in_progress'
      WHEN s.titling_attempts >= ${children_import_TITLING_MAX_ATTEMPTS} THEN 'stopped'
      WHEN s.titling_requested_at IS NULL AND ${children_importedSessionSql('s')} THEN 'imported'
      ELSE 'waiting' END AS reason FROM sessions s WHERE s.project_id = ? AND s.session_id = ?`)
    .bind(projectId, sessionId).first<{ reason: children_UntitledReason | null }>();
  return row?.reason ?? null;
}

 async function children_listChildren<T>(
  db: children_import_RelationalStore,
  query: children_ChildQuery<T>,
  scope: children_import_ReadScope,
  sessionId: string,
  opts: children_ChildOptions = {},
  filters: readonly children_ChildFilter[] = []
): Promise<children_import_Page<T & { orderedAt: number }>> {
  const order = query.orderColumn;
  const k = children_import_keyset(opts, { order, id: query.idColumn, direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const limit = k.limit;
  const conditions = ['project_id = ?', 'session_id = ?'];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.promptId !== undefined) {
    conditions.push(`${query.promptHint ?? 'prompt_id'} = ?`); params.push(opts.promptId);
    if (query.promptHint !== undefined) conditions.push(hook_placement_hookPlacementSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` }));
  }
  for (const filter of filters) { conditions.push(filter.sql); params.push(...filter.params); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const sql = `SELECT ${children_childColumns(query)}, ${order} AS order_at, ${query.idColumn} FROM ${query.table}${query.index === undefined ? '' : ` INDEXED BY ${query.index}`}
                WHERE ${conditions.join(' AND ')}
                ORDER BY ${order} ASC, ${query.idColumn} ASC LIMIT ?`;
  const { results } = await ({ results: await queryRows<Record<string, unknown>>(db,sql,[...params, limit + 1],'all') });
  const rows = results.map((row) => ({ ...query.map(row), orderedAt: row.order_at as number, __id: row[query.idColumn] as string }));
  const paged = children_import_page(rows, limit, (r) => ({ createdAt: r.orderedAt, id: r.__id }));
  return { rows: paged.rows.map(({ __id, ...rest }) => rest as T & { orderedAt: number }), cursor: paged.cursor };
}

export { children_listContextInjections, children_listPlans, children_listAttachments, children_listReadyTitleSessions, type children_TitleCandidate, type children_TitleCandidateWindow, children_listTitleCandidates, children_countConvergenceTitleSessions, children_untitledReason };
