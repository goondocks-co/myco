import { readSessionDetail } from '../../db/sessions/publication.js';
import {
  documentCountRows, existingProjectIds, heldSessionRows, importerOwnedSessions, projectExists, projectListRows, sessionCountsRow, sessionDurationRow,
  sessionHasTitle, sessionInProject, sessionLifecycleRow, sessionOnMachine, sessionsHoldingImportedPrompts,
} from '../../db/sessions/session-reads.js';
import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import { page as sessions_import_page, clampLimit as sessions_import_clampLimit, decodeCursor as sessions_import_decodeCursor } from "../scope.js";
import { decodeSessionsAcrossCursor as sessions_import_decodeAcrossCursor, sessionsAcrossPage as sessions_import_acrossPage } from "../project-cursor.js";
import {
  readSessionPage as sessions_import_readSessionPage,
  SESSION_OCCURRED_AT as sessions_import_SESSION_OCCURRED_AT,
  WORKING_CAP_MS as sessions_import_WORKING_CAP_MS,
} from "../../db/sessions/browse.js";
import type { Page as sessions_import_Page } from "../scope.js";
import type { ProjectSet as sessions_import_ProjectSet } from "../scope.js";
import type { ReadScope as sessions_import_ReadScope } from "../scope.js";
import { CAPTURE_RULE_BUNDLES as sessions_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { sourceTimestampsRecorded as sessions_import_sourceTimestampsRecorded } from "@goondocks/myco-shared/capture-rules";

interface sessions_ProjectRow {
  projectId: string;
  name: string;
  createdAt: number;
  sessionCount: number;
  lastActivityAt: number | null;
  /** The archive time and who archived it; null while the project accepts capture. */
  archivedAt: number | null;
  archivedBy: string | null;
}

/** A session and the facts that identify the run that produced it. `agent`, `branch`, `originPath` and `parentSessionId` are what separate a sandboxed headless run from a laptop run; a view without them cannot show which is which. */
interface sessions_SessionRow {
  sessionId: string;
  machineId: string | null;
  createdByTokenId: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The member whose End session applied the standing end; null for an end an agent's hook or an import applied. */
  endedBy: string | null;
  endedByLabel: string | null;
  originPath: string | null;
  /** The session this one continues under a new id, and the continuation's recorded reason. */
  parentSessionId: string | null;
  parentReason: string | null;
  /** The session that launched this one, as the launcher named it; it may name a session this Project does not hold. */
  launchParentSessionId: string | null;
  /** The member and runtime behind the credential that captured the session; null when the credential row is gone. */
  memberId: string | null;
  memberLabel: string | null;
  /**
   * The name of the machine the session came from. A read leaves it null: a facade names the viewer's own machines
   * with `nameOwnMachines`, and anyone else's machine is shown as its member, never by name.
   */
  runtimeLabel: string | null;
  runtimeKind: string | null;
  /**
   * When the session's open turn started, in the member's clock; null while no turn is open, and when the recorded end
   * is newer than the turn. A turn newer than the recorded end is a session resumed after it: working again, with its
   * recorded end left as it stands.
   */
  workingSince: number | null;
  /**
   * Whether the session is working now: a turn open for less than `WORKING_CAP_MS`, however long it has gone without
   * sending anything. False for a read given no instant to judge by.
   */
  working: boolean;
  /** The title written on the Deployment after the session ended; null until then. */
  title: string | null;
  summary: string | null;
  /** The time of the titling attempt, whatever its outcome; null while nothing has tried. */
  titledAt: number | null;
  /** What a list or a header shows: the title, else the opening line of the first user prompt, else the agent, else the id. */
  label: string;
}

/** Counts of a session's child projections, for a detail view that shows what it holds before fetching any of it. */
interface sessions_SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

/** The longest label the fallback rule produces. */
const sessions_LABEL_MAX_CHARS = 80;

/** What a label shows for a session with no title, typed prompt or agent, where an id fragment must never reach the reader. */
const sessions_UNTITLED_SESSION_LABEL = 'Untitled session';

/** The one label rule for a session's words: a stored title as is; else the first prompt's first line, whitespace collapsed, cut at `LABEL_MAX_CHARS` on a word boundary; else the agent; else null. */
function sessions_namedLabel(title: string | null, firstPrompt: string | null, agent: string | null): string | null {
  if (title !== null && title.trim() !== '') return title.trim();
  const line = firstPrompt === null ? '' : (firstPrompt.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  if (line !== '') {
    if (line.length <= sessions_LABEL_MAX_CHARS) return line;
    const cut = line.slice(0, sessions_LABEL_MAX_CHARS);
    const boundary = line[sessions_LABEL_MAX_CHARS] === ' ' ? sessions_LABEL_MAX_CHARS : cut.lastIndexOf(' ');
    return `${(boundary > sessions_LABEL_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
  }
  if (agent !== null && agent.trim() !== '') return agent.trim();
  return null;
}

/** The shared label for lists, detail, activity and related sessions. */
function sessions_sessionLabel(title: string | null, firstPrompt: string | null, agent: string | null): string {
  return sessions_namedLabel(title, firstPrompt, agent) ?? sessions_UNTITLED_SESSION_LABEL;
}

const sessions_WORKING_CAP_MS = sessions_import_WORKING_CAP_MS;

const sessions_text = (value: unknown): string | null => (value as string | null) ?? null;

const sessions_num = (value: unknown): number | null => (value as number | null) ?? null;

function sessions_toSession(row: Record<string, unknown>, nowMs?: number): sessions_SessionRow {
  const open = sessions_num(row.working_since);
  const workingSince = open !== null && (row.ended_at == null || open > (row.ended_at as number)) ? open : null;
  return {
    sessionId: row.session_id as string,
    machineId: sessions_text(row.machine_id),
    createdByTokenId: row.created_by_token_id as string,
    firstReceivedAt: row.first_received_at as number,
    lastReceivedAt: row.last_received_at as number,
    agent: sessions_text(row.agent),
    branch: sessions_text(row.branch),
    startedAt: sessions_num(row.started_at),
    endedAt: sessions_num(row.ended_at),
    endedBy: sessions_text(row.ended_by),
    endedByLabel: sessions_text(row.ended_by_label),
    originPath: sessions_text(row.origin_path),
    parentSessionId: sessions_text(row.parent_session_id),
    parentReason: sessions_text(row.parent_reason),
    launchParentSessionId: sessions_text(row.launch_parent_session_id),
    memberId: sessions_text(row.member_id),
    memberLabel: sessions_text(row.member_label),
    runtimeLabel: null,
    workingSince,
    working: nowMs !== undefined && workingSince !== null && workingSince > nowMs - sessions_WORKING_CAP_MS,
    runtimeKind: sessions_text(row.runtime_kind),
    title: sessions_text(row.title),
    summary: sessions_text(row.summary),
    titledAt: sessions_num(row.titled_at),
    label: sessions_sessionLabel(sessions_text(row.title), sessions_text(row.first_prompt), sessions_text(row.agent)),
  };
}

/** Every project with its live session count and most recent live receipt, most recently active first; a project with no live session still lists with a count of zero. Unscoped: the caller decides which projects its credential may see. */
async function sessions_listProjects(db: sessions_import_RelationalStore, opts: { includeArchived?: boolean } = {}): Promise<sessions_ProjectRow[]> {
  const rows = await projectListRows(db, opts.includeArchived === true);
  return rows.map((row) => ({
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at,
    sessionCount: row.session_count,
    lastActivityAt: row.last_activity_at ?? null,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
  }));
}

/** Sessions ordered by presented start and session ID. Refinement can move rows between keyset pages. */
interface sessions_SessionFilters {
  branch?: string;
  /** Sessions started at or after this instant (ms); under an activity window, sessions active at or after it. */
  since?: number;
  /** Sessions started before this instant (ms); a session started exactly at it is not listed. */
  until?: number;
  /**
   * What the window's two instants bound. `start` (the default) is when the session started. `activity` is the span
   * of its activity: a session is listed when it started before the window's end and its activity reaches the
   * window's start — its last event received then or later, and no end recorded before it. A session that started yesterday and is
   * live now is in today's window and in yesterday's. An activity window needs its start instant.
   */
  window?: 'start' | 'activity';
  /** `open` is a session with no end recorded; `ended` one with an end. */
  state?: 'open' | 'ended';
  /**
   * The instant working is judged against. A read given it marks each session working or not, and under an activity
   * window also lists every session working now, whatever its last receipt: a long turn sends nothing until it ends.
   */
  now?: number;
  /** The label of the member whose credential captured the session. */
  memberLabel?: string;
  /** The agent that captured the session, as the session records it. */
  agent?: string;
  /** One session, by its exact id. */
  sessionId?: string;
  /**
   * Which sessions this read admits by the fidelity of the transcripts behind
   * them. `full` admits only sessions every transcript of which the parser
   * could read completely; `any` admits all.
   *
   * `listSessions` defaults to `full` and `listSessionSummaries` to `any`, and
   * the difference is deliberate. Everything that assembles extraction material
   * reads the former; a person or an agent browsing history reads the latter.
   * The default fails closed on the expensive side: a session hidden from a
   * page is an absence someone can see, while knowledge extracted from a
   * transcript known to be incomplete reads exactly like knowledge that is not.
   */
  fidelity?: 'full' | 'any';
}

/**
 * When a session happened, for ordering: its own start where it has one, and
 * the receipt where it does not.
 *
 * The receipt records when the Deployment learned of a session, which is a
 * different instant from when the session ran. The two coincide for live
 * capture and diverge everywhere else — a month-old transcript imported today,
 * a spool drained days after an outage — and ordering on the receipt puts both
 * at the top of a list of recent work.
 *
 * The keyset predicate, the sort and the page cursor all derive from this one
 * expression. A sort changed without the other two leaves the cursor comparing
 * a column the rows are no longer ordered by, which drops and repeats rows
 * across pages rather than failing.
 */
/** The instant a session is ordered by: `PRESENTED_STARTED_AT` falling through to the first receipt, spelled flat. `idx_sessions_occurred` indexes this exact expression; a nested form plans as a sort instead, so the two are written the same way and move together. */
const sessions_SESSION_OCCURRED_AT = sessions_import_SESSION_OCCURRED_AT;

async function sessions_listSessions(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow>> {
  const listed = await sessions_selectSessions(db, { projectId: scope.projectId }, opts);
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/**
 * Sessions of every Project in the set, newest first, one keyset page at a time: the read walks
 * `idx_sessions_occurred_project` and stops at its page. A session is keyed by its Project and its id, so the page orders
 * by the instant, the Project and then the id, and the cursor carries all three.
 */
async function sessions_listSessionsAcross(db: sessions_import_RelationalStore, set: sessions_import_ProjectSet, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  return sessions_selectSessions(db, set, opts);
}

/** Whether the read bounds sessions by the span they were active. An activity window with no start instant bounds nothing it can seek. */
function sessions_activityWindow(opts: sessions_SessionFilters): boolean {
  if (opts.window !== 'activity') return false;
  if (opts.since === undefined) throw new RangeError('an activity window needs since');
  return true;
}

/**
 * The one session page: the stored rows `readSessionPage` answers for the scope and filters, merged and presented, and
 * the cursor of the next page. A cursor this list did not issue reads nothing.
 */
async function sessions_selectSessions(
  db: sessions_import_RelationalStore,
  scope: { projectId: string } | sessions_import_ProjectSet,
  opts: { limit?: number; cursor?: string } & sessions_SessionFilters,
): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  const active = sessions_activityWindow(opts);
  const across = !('projectId' in scope);
  const limit = sessions_import_clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : across ? sessions_import_decodeAcrossCursor(opts.cursor) : sessions_import_decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const { received, working } = await sessions_import_readSessionPage(db, { scope, filters: opts, active, after, limit });
  const rows = sessions_mergeSessionPages(received, working).map((row) => ({ ...sessions_toSession(row, opts.now), projectId: row.project_id as string }));
  // The cursor carries the same value the sort ordered by. Both columns are
  // already on the row, so this is the SQL COALESCE read back rather than a
  // second definition of it.
  return across
    ? sessions_import_acrossPage(rows, limit, (r) => ({ createdAt: r.startedAt ?? r.firstReceivedAt, projectId: r.projectId, id: r.sessionId }))
    : sessions_import_page(rows, limit, (r) => ({ createdAt: r.startedAt ?? r.firstReceivedAt, id: r.sessionId }));
}

const descending = (x: string, y: string): number => (x < y ? 1 : x === y ? 0 : -1);

/** Two pages of session rows as one, each session once, in the order a page reads: newest occurrence first, then Project, then id. */
function sessions_mergeSessionPages(a: Record<string, unknown>[], b: Record<string, unknown>[]): Record<string, unknown>[] {
  if (b.length === 0) return a;
  const key = (row: Record<string, unknown>) => `${row.project_id as string}\u0000${row.session_id as string}`;
  const occurred = (row: Record<string, unknown>) => (row.started_at as number | null) ?? (row.first_received_at as number);
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((row) => !seen.has(key(row)))].sort((x, y) =>
    occurred(y) - occurred(x) || descending(x.project_id as string, y.project_id as string) || descending(x.session_id as string, y.session_id as string));
}

/** Elapsed source time, or observed time when a recorded endpoint anchors it. Synthetic transcript bounds establish neither. */
async function sessions_sessionDurationMs(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<number | null> {
  const row = await sessionDurationRow(db, scope.projectId, sessionId);
  if (row === null) return null;
  const recorded = sessions_import_sourceTimestampsRecorded(sessions_import_CAPTURE_RULE_BUNDLES, row.agent);
  const start = recorded ? row.occurred_started_at ?? row.started_at : row.occurred_started_at === null ? row.started_at : null;
  const end = recorded ? row.occurred_ended_at ?? row.ended_at : row.occurred_ended_at === null || row.ended_by !== null ? row.ended_at : null;
  if (start === null && end === null) return null;
  return Math.max(0, (end ?? row.last_received_at) - (start ?? row.first_received_at));
}

/**
 * A session's lifecycle columns, with no presented date over them. Admission,
 * reopening, ending and titling read these: a session presented as finished is
 * still open to the lifecycle until an end lands. A deleted session answers null.
 */
interface sessions_SessionLifecycle {
  machineId: string | null;
  createdByTokenId: string;
  startedAt: number | null;
  endedAt: number | null;
  firstReceivedAt: number;
}

async function sessions_sessionLifecycle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<sessions_SessionLifecycle | null> {
  const row = await sessionLifecycleRow(db, scope.projectId, sessionId);
  return row === null ? null : {
    machineId: row.machine_id,
    createdByTokenId: row.created_by_token_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    firstReceivedAt: row.first_received_at,
  };
}

/** The counts a list shows beside each session: the counters its document's catalog row keeps. */
type sessions_ListCounts = Omit<sessions_SessionCounts, 'attachments'>;

/** The catalog counters of every named session; a session with no live document counts zero. */
async function sessions_sessionCountsFor(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Map<string, sessions_ListCounts>> {
  const [rows] = await documentCountRows(db, [{ project: scope.projectId, sessions: sessionIds }]);
  return sessions_countsOf(sessionIds, rows ?? []);
}

/** The counters of the sessions whose documents the rows describe; every other named session counts zero. */
function sessions_countsOf(sessionIds: readonly string[], rows: readonly { session_id: string; prompts: number; tool_calls: number; replies: number; plans: number }[]): Map<string, sessions_ListCounts> {
  const out = new Map<string, sessions_ListCounts>(sessionIds.map(id => [id, { prompts: 0, toolCalls: 0, responses: 0, plans: 0 }]));
  for (const row of rows) out.set(String(row.session_id), { prompts: Number(row.prompts), toolCalls: Number(row.tool_calls), responses: Number(row.replies), plans: Number(row.plans) });
  return out;
}

/** A session row with the counts the rail shows beside it. */
interface sessions_SessionSummaryRow extends sessions_SessionRow {
  promptCount: number;
  toolCallCount: number;
}

/** The session list with its rail facts: the catalog counters of the page's sessions only. The dashboard and the MCP tool both read the list through this. */
const sessions_listSessionSummaries = sessions_listSessionSummariesImpl;

async function sessions_listSessionSummariesImpl(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, opts: { limit?: number; cursor?: string } & sessions_SessionFilters, nowMs: number): Promise<sessions_import_Page<sessions_SessionSummaryRow>> {
  // A person and an agent browsing history see every session, labelled by what
  // its transcript could carry; the caller may still narrow.
  const listed = await sessions_listSessions(db, scope, { fidelity: 'any', now: nowMs, ...opts });
  const ids = listed.rows.map((r) => r.sessionId);
  const counts = await sessions_sessionCountsFor(db, scope, ids);
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((row) => {
      const c = counts.get(row.sessionId);
      return { ...row, promptCount: c?.prompts ?? 0, toolCallCount: c?.toolCalls ?? 0 };
    }),
  };
}

/** A session of a read across Projects, with the rail facts the per-Project list carries and the Project it belongs to. */
type sessions_SessionAcrossRow = sessions_SessionSummaryRow & { projectId: string };

/**
 * The session list across a set of Projects with the per-Project list's rail facts. Each child table is keyed by
 * Project first, so the facts are read per Project over that Project's ids on the page, every statement in one batch.
 */
const sessions_listSessionSummariesAcross = sessions_listSessionSummariesAcrossImpl;

async function sessions_listSessionSummariesAcrossImpl(db: sessions_import_RelationalStore, set: sessions_import_ProjectSet, opts: { limit?: number; cursor?: string } & sessions_SessionFilters, nowMs: number): Promise<sessions_import_Page<sessions_SessionAcrossRow>> {
  const listed = await sessions_listSessionsAcross(db, set, { fidelity: 'any', now: nowMs, ...opts });
  const byProject = new Map<string, string[]>();
  for (const row of listed.rows) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.sessionId]);
  const projects = [...byProject];
  const found = await documentCountRows(db, projects.map(([project, sessions]) => ({ project, sessions })));
  const counts = new Map<string, Map<string, sessions_ListCounts>>(projects.map(([projectId, ids], at) => [projectId, sessions_countsOf(ids, found[at]!)]));
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((row) => {
      const c = counts.get(row.projectId)?.get(row.sessionId);
      return { ...row, promptCount: c?.prompts ?? 0, toolCallCount: c?.toolCalls ?? 0 };
    }),
  };
}

/** True when the project exists. The core answers what is there; a facade decides whether its caller may see it. */
const sessions_projectExists = projectExists;

/** Which of these Project ids name a Project, in one statement. */
async function sessions_existingProjects(db: sessions_import_RelationalStore, projectIds: readonly string[]): Promise<Set<string>> {
  return new Set(await existingProjectIds(db, projectIds));
}

/** True when the session exists inside the scope. `sessions` is keyed `(project_id, session_id)`, so containment is the only safe question to ask of a session id. */
async function sessions_sessionInScope(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  return sessionInProject(db, scope.projectId, sessionId);
}

/**
 * True when the session sits inside the scope and the named machine holds it.
 *
 * One question, one answer: a session another machine captured reads the same
 * as one the Project never held, so a caller naming an id it does not own
 * learns nothing about whether that id exists.
 */
async function sessions_sessionHeldByMachine(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, machineId: string): Promise<boolean> {
  return sessionOnMachine(db, scope.projectId, sessionId, machineId);
}

/** True when the Project holds this session, whichever machine captured it: what a run's dispatch-named session is checked against before a write names it. */
const sessions_projectHoldsSession = async (db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> => sessionInProject(db, scope.projectId, sessionId);

/** Whether a session inside the scope carries a title. The row a titling run owed, as the store holds it. */
async function sessions_sessionCarriesTitle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  return sessionHasTitle(db, scope.projectId, sessionId);
}

/** Which of these sessions the Project holds a row for, whatever their state. */
async function sessions_heldSessionIds(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Set<string>> {
  return new Set(await heldSessionRows(db, scope.projectId, sessionIds));
}

/** Sessions whose original facts were recorded by a named importer. */
async function sessions_sessionsOwnedByImporter(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  return new Set(await importerOwnedSessions(db, scope.projectId, sessionIds, producer));
}

/** Which of these sessions hold a prompt `producer` sent on the import channel. */
async function sessions_sessionsWithImportedPrompts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  return new Set(await sessionsHoldingImportedPrompts(db, scope.projectId, sessionIds, producer));
}

/** One session inside the scope, or null — including when the session exists under another project. */
/** One session; given `nowMs`, marked working or not. */
 async function sessions_getSession(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, nowMs?: number): Promise<(sessions_SessionRow & { publishedRevision: number }) | null> {
  const row = await readSessionDetail(db, scope.projectId, sessionId);
  return row === null ? null : { ...sessions_toSession(row, nowMs), publishedRevision: row.published_revision };
}

/** How many of each child a session holds. One statement per table rather than a join: the projections have no common key and a five-way LEFT JOIN would multiply rows. */
 async function sessions_sessionCounts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<sessions_SessionCounts> {
  return await sessionCountsRow(db, scope.projectId, sessionId) ?? { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 };
}

export {
  type sessions_ProjectRow,
  type sessions_SessionRow,
  sessions_sessionLabel,
  sessions_WORKING_CAP_MS,
  sessions_listProjects,
  type sessions_SessionFilters,
  sessions_SESSION_OCCURRED_AT,
  sessions_listSessions,
  sessions_listSessionsAcross,
  sessions_getSession,
  sessions_sessionDurationMs,
  sessions_sessionLifecycle,
  sessions_sessionCounts,
  sessions_listSessionSummaries,
  type sessions_SessionAcrossRow,
  sessions_listSessionSummariesAcross,
  sessions_projectExists,
  sessions_existingProjects,
  sessions_sessionInScope,
  sessions_sessionHeldByMachine,
  sessions_projectHoldsSession,
  sessions_sessionCarriesTitle,
  sessions_heldSessionIds,
  sessions_sessionsOwnedByImporter,
  sessions_sessionsWithImportedPrompts,
};
