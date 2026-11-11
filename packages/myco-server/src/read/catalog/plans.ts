import type { RelationalStore } from '../../core/adapters.js';
import { PLAN_STATUSES } from '../../ingest/kinds.js';
import { clampLimit, decodeCursor, encodeCursor, type Page, type ProjectSet, type ReadScope } from '../scope.js';
import { readPlanPage, readPlanTags, type PlanListRow, type PlanPageKey } from '../../db/plans/browse.js';
import { planInSession, readPlanDetail, readPlanSummary } from '../../db/plans/detail.js';
import { planStatusTotals } from '../../db/plans/counts.js';

/** The statuses an administrative edit may write — the catalogue's; the list filter alone admits 'all'. */
const plans_WRITABLE_PLAN_STATUSES: ReadonlySet<string> = new Set(PLAN_STATUSES);

const plans_PLAN_STATUS_MESSAGE = `status must be one of: ${PLAN_STATUSES.join(', ')}`;

/**
 * A plan as a list shows it: its metadata, a preview of its opening and the progress of its task list, never its body
 * (the plan's own read answers that). `progress` is `checked/total`, `N/A` for a plan with no task list or one whose
 * body is stored apart, and null while Myco is still deriving it for a plan written before it kept progress.
 */
interface plans_PlanListItem {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  originPath: string | null;
  /** The opening of the plan's body, with line breaks read as spaces; null for a body stored apart or not yet derived. */
  preview: string | null;
  progress: string | null;
  /** The member behind its last administrative edit, null when a capture event wrote last. */
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** A plan listed across Projects, with the Project it belongs to. */
type plans_PlanAcrossRow = plans_PlanListItem & { projectId: string };

/**
 * How a plan was resolved: what landed, why it was dropped or what is pending, when it was resolved (null for a live
 * plan curation reviewed and left open), the plan that superseded it, and the evidence the decision cited.
 */
interface plans_PlanResolution { note: string | null; resolvedAt: number | null; supersededBy: string | null; evidence: string[] }

/** A plan as the Project holds it, in full: the listed fields plus its body or the object holding it. */
interface plans_ProjectPlanRow extends plans_PlanListItem {
  content: string | null;
  blobKey: string | null;
  /** The registered object admitted by this plan's processed-field provenance, or null. */
  objectKey: string | null;
  /** Null for a plan nobody has resolved or reviewed. */
  resolution: plans_PlanResolution | null;
}

const resolutionOf = (row: { resolution_note: string | null; resolved_at: number | null; superseded_by: string | null; outcome_refs: string | null }): plans_PlanResolution | null =>
  row.resolution_note === null && row.resolved_at === null ? null
    : { note: row.resolution_note, resolvedAt: row.resolved_at, supersededBy: row.superseded_by, evidence: row.outcome_refs === null ? [] : JSON.parse(row.outcome_refs) as string[] };

/** A plan's bounded metadata, including the content revision and source session. */
interface plans_ProjectPlanSummary { planKey: string; title: string | null; status: string; sessionId: string; contentHash: string | null }

/** A task list item: a `-`, `*`, `+` or ordered list marker, a space, then `[ ]`, `[x]` or `[X]` alone or before a space. */
const TASK_ITEM = /^(?:[-*+]|\d{1,9}[.)]) \[([ xX])\](?: |$)/;
const FENCE = /^(?:```|~~~)/;

/**
 * `checked/total` over a plan body's task list read as Markdown, or `N/A` when it has none: what a document's own
 * appearance of a plan shows. The rules are those the stored progress is derived by (`db/plans/metadata.ts`): a line
 * inside a fenced code block is an example, never an item.
 */
function plans_progressOf(content: string | null): string {
  let fenced = false, checked = 0, total = 0;
  for (const raw of (content ?? '').replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/^[ \t]+/, '');
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    const item = fenced ? null : TASK_ITEM.exec(line);
    if (item === null) continue;
    total += 1;
    if (item[1] !== ' ') checked += 1;
  }
  return total === 0 ? 'N/A' : `${checked}/${total}`;
}

/** The stored progress as the list answers it; null until it has been derived. */
const storedProgress = (done: number | null, total: number | null): string | null =>
  done === null || total === null ? null : total === 0 ? 'N/A' : `${done}/${total}`;

function listed(row: PlanListRow, tags: string[]): plans_PlanAcrossRow {
  return {
    projectId: row.project_id, planKey: row.plan_key, sessionId: row.session_id, promptId: row.prompt_id, title: row.title, status: row.status,
    originPath: row.origin_path, preview: row.preview, progress: storedProgress(row.progress_done, row.progress_total), updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at, tags,
  };
}

/** The listed rows of a page read as `limit` + 1 rows, with their tags in one read, and the last shown row when more follow. */
async function withTags(db: RelationalStore, rows: readonly PlanListRow[], limit: number): Promise<{ rows: plans_PlanAcrossRow[]; more: boolean }> {
  const shown = rows.slice(0, limit);
  const tags = await readPlanTags(db, shown.map(row => ({ projectId: row.project_id, planKey: row.plan_key })));
  return { rows: shown.map(row => listed(row, tags.get(row.project_id)?.get(row.plan_key) ?? [])), more: rows.length > limit };
}

const withoutProject = ({ projectId: _projectId, ...row }: plans_PlanAcrossRow): plans_PlanListItem => row;
const nextInProject = (rows: readonly plans_PlanListItem[], more: boolean): string | null => {
  const last = rows.at(-1);
  return more && last !== undefined ? encodeCursor(last.updatedAt, last.planKey) : null;
};

/** The structured filters of a Project's plan list: a status, or a session (optionally with a status). */
interface plans_ProjectPlanOptions { status?: string; sessionId?: string; limit?: number; cursor?: string }

/**
 * One page of the Project's plans, most recently edited first, and the cursor of the next; null for a cursor this list
 * did not issue. A cursor is a position, not a snapshot: a plan edited while a reader pages moves to the head of the
 * list, so a reader already past it does not see it again and a reader not yet at it does not reach it on later pages;
 * a fresh first page shows it. Every unedited plan keeps its place, so later pages neither repeat nor drop one.
 */
async function plans_pageProjectPlans(db: RelationalStore, scope: ReadScope, opts: plans_ProjectPlanOptions = {}): Promise<Page<plans_PlanListItem> | null> {
  const limit = clampLimit(opts.limit);
  const key = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && key === null) return null;
  const after: PlanPageKey | null = key === null ? null : { updatedAt: key.createdAt, planKey: key.id };
  const rows = await readPlanPage(db, opts.sessionId === undefined
    ? { scope: { projectId: scope.projectId }, ...(opts.status === undefined ? {} : { status: opts.status }), after, limit }
    : { scope: { projectId: scope.projectId, sessionId: opts.sessionId }, order: 'newest', ...(opts.status === undefined ? {} : { status: opts.status }), after, limit });
  const page = await withTags(db, rows, limit);
  const items = page.rows.map(withoutProject);
  return { rows: items, cursor: nextInProject(items, page.more) };
}

/** A session's plan as its plans tab lists it, with the edit instant the tab pages over. */
type plans_SessionPlanRow = plans_PlanListItem & { orderedAt: number };

/**
 * One page of a session's plans, oldest edit first as the session's timeline reads, and the cursor of the next; an
 * empty page for a cursor this list did not issue. A plan edited while a reader pages moves to the end, so a reader
 * already past it reads it again there; every unedited plan keeps its place.
 */
async function plans_pageSessionPlans(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: { status?: string; limit?: number; cursor?: string } = {}): Promise<Page<plans_SessionPlanRow>> {
  const limit = clampLimit(opts.limit);
  const key = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && key === null) return { rows: [], cursor: null };
  const rows = await readPlanPage(db, { scope: { projectId: scope.projectId, sessionId }, order: 'oldest',
    ...(opts.status === undefined ? {} : { status: opts.status }), after: key === null ? null : { updatedAt: key.createdAt, planKey: key.id }, limit });
  const page = await withTags(db, rows, limit);
  const items = page.rows.map(row => ({ ...withoutProject(row), orderedAt: row.updatedAt }));
  return { rows: items, cursor: nextInProject(items, page.more) };
}

/**
 * The prefix naming the encoding of the cross-Project plan list's cursor: the edit instant, the Project, then the plan.
 * It marks a position, not a snapshot: unedited plans neither repeat nor drop across pages, and a plan edited meanwhile
 * moves to the head, where a fresh first page shows it.
 */
const ACROSS_CURSOR_PREFIX = 'plans1:';
const PROJECT_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The refusal of a cursor the cross-Project plan list did not issue, including one issued before it ordered by Project before plan. */
const plans_ACROSS_CURSOR_REFUSAL =
  `malformed cursor: the plan list across Projects pages by "${ACROSS_CURSOR_PREFIX}<instant>:<projectId>:<planKey>" exactly as its last answer returned it in \`cursor\`; `
  + 'a cursor another list issued, or one issued before this list ordered by edit, Project and then plan, is refused. '
  + 'Nothing was read: request the first page again with the same filters and no cursor.';

const encodeAcross = (row: plans_PlanAcrossRow) => `${ACROSS_CURSOR_PREFIX}${row.updatedAt}:${row.projectId}:${row.planKey}`;

/** The key of a cursor the cross-Project plan list issued, or null for any other text. */
function plans_decodeAcrossCursor(text: string): PlanPageKey | null {
  if (!text.startsWith(ACROSS_CURSOR_PREFIX)) return null;
  const body = text.slice(ACROSS_CURSOR_PREFIX.length);
  const first = body.indexOf(':');
  const second = first < 0 ? -1 : body.indexOf(':', first + 1);
  if (first <= 0 || second < 0) return null;
  const updatedAt = Number(body.slice(0, first));
  const projectId = body.slice(first + 1, second);
  const planKey = body.slice(second + 1);
  return Number.isSafeInteger(updatedAt) && PROJECT_ID.test(projectId) && planKey.length > 0 ? { updatedAt, projectId, planKey } : null;
}

/**
 * One page of every plan in the set's Projects, most recently edited first, optionally a status and a start instant on
 * the last edit; null for a cursor this list did not issue. Plans order by the edit, the Project and the plan, so plans
 * of two Projects sharing an instant and a key each keep their own place across a page boundary.
 */
async function plans_pagePlansAcross(db: RelationalStore, set: ProjectSet,
  opts: { status?: string; since?: number; limit?: number; cursor?: string } = {}): Promise<Page<plans_PlanAcrossRow> | null> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : plans_decodeAcrossCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return null;
  const rows = await readPlanPage(db, { scope: set, ...(opts.status === undefined ? {} : { status: opts.status }),
    ...(opts.since === undefined ? {} : { since: opts.since }), after, limit });
  const page = await withTags(db, rows, limit);
  const last = page.rows.at(-1);
  return { rows: page.rows, cursor: page.more && last !== undefined ? encodeAcross(last) : null };
}

/**
 * How many plans of each status the Projects hold, read from the maintained counters: a status no plan holds is absent,
 * and `building` answers until existing plans have been counted. A total under a start instant is not kept: such a
 * list pages with `hasMore` alone.
 */
const plans_planTotals = planStatusTotals;

function plans_getPlan(db: RelationalStore, scope: ReadScope, planKey: string, options: { summary: true }): Promise<plans_ProjectPlanSummary | null>;
function plans_getPlan(db: RelationalStore, scope: ReadScope, planKey: string): Promise<plans_ProjectPlanRow | null>;
/** One plan in full with its tags, or its bounded summary; null when the Project holds no such plan. */
async function plans_getPlan(db: RelationalStore, scope: ReadScope, planKey: string, options: { summary?: boolean } = {}): Promise<plans_ProjectPlanSummary | plans_ProjectPlanRow | null> {
  if (options.summary) {
    const row = await readPlanSummary(db, scope.projectId, planKey);
    return row === null ? null : { planKey: row.plan_key, title: row.title, status: row.status, sessionId: row.session_id, contentHash: row.content_hash };
  }
  const row = await readPlanDetail(db, scope.projectId, planKey);
  if (row === null) return null;
  const tags = await readPlanTags(db, [{ projectId: scope.projectId, planKey }]);
  return {
    planKey: row.plan_key, sessionId: row.session_id, promptId: row.prompt_id, title: row.title, status: row.status, content: row.content,
    blobKey: row.blob_key, objectKey: row.object_key, originPath: row.origin_path, preview: row.preview,
    progress: storedProgress(row.progress_done, row.progress_total), updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
    tags: tags.get(scope.projectId)?.get(planKey) ?? [], resolution: resolutionOf(row),
  };
}

/** True when the plan sits in the session inside the scope. */
const plans_planInSession = (db: RelationalStore, scope: ReadScope, sessionId: string, planKey: string): Promise<boolean> =>
  planInSession(db, scope.projectId, sessionId, planKey);

export {
  type plans_PlanListItem, type plans_ProjectPlanRow, type plans_PlanAcrossRow, type plans_ProjectPlanSummary,
  plans_WRITABLE_PLAN_STATUSES, plans_PLAN_STATUS_MESSAGE, plans_ACROSS_CURSOR_REFUSAL, plans_progressOf, plans_pageProjectPlans,
  plans_pageSessionPlans,
  plans_decodeAcrossCursor, plans_pagePlansAcross, plans_planTotals, plans_getPlan, plans_planInSession,
};
