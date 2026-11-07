import { sessionDocumentUnreadSql } from '../../db/document-tables.js';
import type { PreparedStatement as sessions_import_PreparedStatement } from "../../core/adapters.js";
import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import type { RunResult as sessions_import_RunResult } from "../../core/adapters.js";
import { occurredAt as sessions_import_occurredAt } from "../../db/session-dates.js";
import { presentedEndedAt as sessions_import_presentedEndedAt } from "../../db/session-dates.js";
import { presentedStartedAt as sessions_import_presentedStartedAt } from "../../db/session-dates.js";
import { containsPattern as sessions_import_containsPattern } from "../scope.js";
import { inListChunks as sessions_import_inListChunks } from "../scope.js";
import { keyset as sessions_import_keyset } from "../scope.js";
import { page as sessions_import_page } from "../scope.js";
import { projectKeyset as sessions_import_projectKeyset, projectPage as sessions_import_projectPage } from "../project-cursor.js";
import { projectsFiltering as sessions_import_projectsFiltering } from "../scope.js";
import type { Page as sessions_import_Page } from "../scope.js";
import type { ProjectSet as sessions_import_ProjectSet } from "../scope.js";
import type { ReadScope as sessions_import_ReadScope } from "../scope.js";
import { notTombstonedSql as sessions_import_notTombstonedSql } from "../../db/session-read-model.js";
import { NOT_TOMBSTONED_PARAMS as sessions_import_NOT_TOMBSTONED_PARAMS } from "../../db/session-read-model.js";
import { sessionMaterialReadySql as sessions_import_sessionMaterialReadySql } from "../material-readiness.js";
import { CAPTURE_RULE_BUNDLES as sessions_import_CAPTURE_RULE_BUNDLES } from "@goondocks/myco-shared/capture-rules-data";
import { sourceTimestampsRecorded as sessions_import_sourceTimestampsRecorded } from "@goondocks/myco-shared/capture-rules";
import { queryRows } from './shared.js';

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

/** What a project holds, counted for its home page. */
interface sessions_ProjectStats {
  sessions: number;
  /** Sessions with no end recorded. A runtime that died never ends its session, so this is what the data says, not a liveness claim. */
  openSessions: number;
  sessionsLast7d: number;
  prompts: number;
  toolCalls: number;
  plans: number;
  attachments: number;
  lastActivityAt: number | null;
}

/** Counts of a session's child projections, for a detail view that shows what it holds before fetching any of it. */
interface sessions_SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

/** How much of the first prompt the label rule reads. */
const sessions_FIRST_PROMPT_CHARS = 160;

/** The longest label the fallback rule produces. */
const sessions_LABEL_MAX_CHARS = 80;

/** The opening of a session's first user prompt as its document catalog keeps it, for the label of a session with no title. */
const sessions_firstPromptSql = (alias: string): string =>
  `(SELECT first_prompt FROM session_documents first_doc WHERE first_doc.project_id = ${alias}.project_id AND first_doc.session_id = ${alias}.session_id)`;

const sessions_FIRST_PROMPT_SQL = sessions_firstPromptSql('s');

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

/** The label the list, the detail and the activity feed share: the words of `namedLabel`, then the id's first eight characters. */
function sessions_sessionLabel(title: string | null, firstPrompt: string | null, agent: string | null, sessionId: string): string {
  return sessions_namedLabel(title, firstPrompt, agent) ?? sessionId.slice(0, 8);
}

/** The same words for a surface that names related sessions, which falls back to `UNTITLED_SESSION_LABEL` and never to the id. */
function sessions_relatedSessionLabel(title: string | null, firstPrompt: string | null, agent: string | null): string {
  return sessions_namedLabel(title, firstPrompt, agent) ?? sessions_UNTITLED_SESSION_LABEL;
}

/** Presented conversation dates fall back to raw lifecycle dates. */
const sessions_PRESENTED_STARTED_AT = sessions_import_presentedStartedAt('s.');

const sessions_PRESENTED_ENDED_AT = sessions_import_presentedEndedAt('s.');

/** All joins land on primary keys, preserving the session row count. */
const sessions_SESSION_COLUMNS = `s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, ${sessions_PRESENTED_STARTED_AT} AS started_at, ${sessions_PRESENTED_ENDED_AT} AS ended_at, s.origin_path, s.parent_session_id, s.parent_reason, s.launch_parent_session_id,
     s.title, s.summary, s.titled_at, s.ended_by, ${sessions_FIRST_PROMPT_SQL} AS first_prompt,
     c.member_id, c.runtime_kind, m.label AS member_label, e.label AS ended_by_label, s.working_since`;

const sessions_SESSION_FROM = sessions_sessionFrom('');

/** The session read's joins, with the sessions table read through `indexedBy` where one is named. */
function sessions_sessionFrom(indexedBy: string): string {
  return `FROM sessions s${indexedBy === '' ? '' : ` INDEXED BY ${indexedBy}`}
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN members e ON e.id = s.ended_by`;
}

/** The Deployment-wide order every read of sessions across Projects walks. */
const sessions_SESSIONS_ACROSS_INDEX = 'idx_sessions_occurred_deployment';

/**
 * The index an activity window reads: it leads with the last receipt, so the read seeks the sessions received from
 * the window's start on, however long ago they started, and sorts that set alone.
 */
const sessions_SESSIONS_ACTIVE_INDEX = 'idx_sessions_capture';

/** The index the sessions working now are read through: it holds the sessions with an open turn alone. */
const sessions_SESSIONS_WORKING_INDEX = 'idx_sessions_working';

/**
 * How long a turn may stay open and still read as working. A turn ends when its end reaches the Deployment; this
 * bounds only a turn whose end never does (a crash, an interrupt no hook reports), which reads as working no longer.
 */
const sessions_WORKING_CAP_MS = 3 * 60 * 60 * 1000;

/** A deleted session is absent from session reads, project counts, and latest activity. */
const sessions_LIVE_SESSION = sessions_import_notTombstonedSql('s');

const sessions_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
    label: sessions_sessionLabel(sessions_text(row.title), sessions_text(row.first_prompt), sessions_text(row.agent), row.session_id as string),
  };
}

/** The Project listing reads one maintained count and at most one live activity receipt per Project. */
function sessions_listProjectsSql(includeArchived = false): string {
  return `SELECT p.project_id, p.name, p.created_at, p.archived_at, p.archived_by,
    COALESCE(c.session_count, 0) AS session_count,
    (SELECT f.last_received_at FROM session_read_facts f
      WHERE f.project_id = p.project_id AND f.has_session = 1 AND f.tombstoned = 0
      ORDER BY f.last_received_at DESC LIMIT 1) AS last_activity_at
    FROM projects p LEFT JOIN project_session_counts c ON c.project_id = p.project_id
    ${includeArchived ? '' : 'WHERE p.archived_at IS NULL'}
    ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC`;
}

/** Every project with its live session count and most recent live receipt, most recently active first; a project with no live session still lists with a count of zero. Unscoped: the caller decides which projects its credential may see. */
async function sessions_listProjects(db: sessions_import_RelationalStore, opts: { includeArchived?: boolean } = {}): Promise<sessions_ProjectRow[]> {
  const { results } = await db.prepare(sessions_listProjectsSql(opts.includeArchived)).all<Record<string, unknown>>();
  return results.map((row) => ({
    projectId: row.project_id as string,
    name: row.name as string,
    createdAt: row.created_at as number,
    sessionCount: row.session_count as number,
    lastActivityAt: (row.last_activity_at as number | null) ?? null,
    archivedAt: (row.archived_at as number | null) ?? null,
    archivedBy: (row.archived_by as string | null) ?? null,
  }));
}

type sessions_ArchiveOutcome = 'archived' | 'absent' | 'already_archived';

type sessions_UnarchiveOutcome = import('../../db/storage/projects.js').UnarchiveOutcome;

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
  sessionId?: string;
  /** A text the session's title, first prompt, agent, branch or id contains, matched case-insensitively. */
  q?: string;
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

/** Every primary and sibling transcript is fully parsed at full fidelity. */
const sessions_FULL_FIDELITY = `${sessions_import_sessionMaterialReadySql('s')} AND NOT EXISTS (SELECT 1 FROM transcripts t
  WHERE t.project_id = s.project_id AND t.session_id = s.session_id
    AND t.fidelity IS NOT NULL AND t.fidelity <> 'full')`;

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
const sessions_SESSION_OCCURRED_AT = sessions_import_occurredAt('s.');

async function sessions_listSessions(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow>> {
  const listed = await sessions_selectSessions(db, { sql: 's.project_id = ?', params: [scope.projectId] }, opts, sessions_activityWindow(opts) ? sessions_SESSIONS_ACTIVE_INDEX : '');
  return { cursor: listed.cursor, rows: listed.rows.map(({ projectId: _projectId, ...row }) => row) };
}

/**
 * Sessions of every Project in the set, newest first, one keyset page at a time. The read walks
 * `idx_sessions_occurred_deployment`, which indexes the same expression the per-Project read orders by, and stops at
 * its page rather than sorting every session the set holds. The index is named in the
 * statement: with a filter the planner takes to be selective, such as an agent, it reads every session and sorts
 * them instead. A session is keyed by its Project and its id, so the page orders by the instant, the Project and the id,
 * and the cursor carries all three: sessions of different Projects sharing an instant and an id each keep their place.
 */
async function sessions_listSessionsAcross(db: sessions_import_RelationalStore, set: sessions_import_ProjectSet, opts: { limit?: number; cursor?: string } & sessions_SessionFilters = {}): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  return sessions_selectSessions(db, sessions_import_projectsFiltering(set, 's'), opts, sessions_activityWindow(opts) ? sessions_SESSIONS_ACTIVE_INDEX : sessions_SESSIONS_ACROSS_INDEX, true);
}

/** Whether the read bounds sessions by the span they were active. An activity window with no start instant bounds nothing it can seek. */
function sessions_activityWindow(opts: sessions_SessionFilters): boolean {
  if (opts.window !== 'activity') return false;
  if (opts.since === undefined) throw new RangeError('an activity window needs since');
  return true;
}

/**
 * The one session page: `projects` admits the rows, the filters narrow them, and the order and the cursor are the
 * occurred instant and the id. `walks` names the index the statement reads through. A read that walks the
 * Deployment-wide order also takes the cursor's instant as an upper bound beside the keyset predicate, which the
 * predicate already implies, so the walk seeks to the cursor instead of reading every newer row again. An activity
 * window reads the sessions received from its start on and sorts them.
 */
async function sessions_selectSessions(
  db: sessions_import_RelationalStore,
  projects: { sql: string; params: readonly unknown[] },
  opts: { limit?: number; cursor?: string } & sessions_SessionFilters,
  walks: string = '',
  across = false,
): Promise<sessions_import_Page<sessions_SessionRow & { projectId: string }>> {
  const active = sessions_activityWindow(opts);
  const k = across
    ? sessions_import_projectKeyset(opts, { order: sessions_SESSION_OCCURRED_AT, project: 's.project_id', id: 's.session_id' })
    : sessions_import_keyset(opts, { order: sessions_SESSION_OCCURRED_AT, id: 's.session_id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const read = (window: 'receipt' | 'working', through: string): Promise<Record<string, unknown>[]> => (async()=>{
    const bounded = through === sessions_SESSIONS_ACROSS_INDEX;
    const conditions = [projects.sql, sessions_LIVE_SESSION];
    if ((opts.fidelity ?? 'full') === 'full') conditions.push(sessions_FULL_FIDELITY);
    const params: unknown[] = [...projects.params];
    if (opts.branch !== undefined) { conditions.push('s.branch = ?'); params.push(opts.branch); }
    if (opts.agent !== undefined) { conditions.push('s.agent = ?'); params.push(opts.agent); }
    if (window === 'working') {
      // Working now: a turn opened within the cap, with no end recorded or one older than the turn.
      conditions.push('s.working_since IS NOT NULL', 's.working_since > ?', `(${sessions_PRESENTED_ENDED_AT} IS NULL OR ${sessions_PRESENTED_ENDED_AT} < s.working_since)`);
      params.push(opts.now! - sessions_WORKING_CAP_MS);
    } else if (active) {
      // Active in the window: a receipt at or after its start, and no end recorded before it.
      conditions.push('s.last_received_at >= ?', `(${sessions_PRESENTED_ENDED_AT} IS NULL OR ${sessions_PRESENTED_ENDED_AT} >= ?)`);
      params.push(opts.since!, opts.since!);
    } else if (opts.since !== undefined) {
      // The instant the page is ordered by, so the filter admits what the order shows.
      conditions.push(`${sessions_SESSION_OCCURRED_AT} >= ?`); params.push(opts.since);
    }
    if (opts.until !== undefined) { conditions.push(`${sessions_SESSION_OCCURRED_AT} < ?`); params.push(opts.until); }
    // Open and ended as the page shows them, each session under one. A session working again after its recorded end is
    // open while it works: the working read lists it as open, and a read of ended sessions judged at an instant leaves it
    // out.
    if (opts.state === 'open' && window !== 'working') conditions.push(`${sessions_PRESENTED_ENDED_AT} IS NULL`);
    if (opts.state === 'ended') {
      conditions.push(`${sessions_PRESENTED_ENDED_AT} IS NOT NULL`);
      if (opts.now !== undefined) {
        conditions.push(`NOT (s.working_since IS NOT NULL AND s.working_since > ${sessions_PRESENTED_ENDED_AT} AND s.working_since > ?)`);
        params.push(opts.now - sessions_WORKING_CAP_MS);
      }
    }
    if (opts.memberLabel !== undefined) { conditions.push('m.label = ?'); params.push(opts.memberLabel); }
    if (opts.sessionId !== undefined) { conditions.push('s.session_id = ?'); params.push(opts.sessionId); }
    if (opts.q !== undefined && opts.q.trim() !== '') {
      const pattern = sessions_import_containsPattern(opts.q.trim());
      conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.agent LIKE ? ESCAPE '\\' OR s.branch LIKE ? ESCAPE '\\' OR s.session_id LIKE ? ESCAPE '\\' OR ${sessions_firstPromptSql('s')} LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (k.where !== '') {
      if (bounded) { conditions.push(`${sessions_SESSION_OCCURRED_AT} <= ?`); params.push(k.params[0]); }
      conditions.push(k.where); params.push(...k.params);
    }
    const { results } = await db.prepare(`SELECT s.project_id, ${sessions_SESSION_COLUMNS} ${sessions_sessionFrom(through)} WHERE ${conditions.join(' AND ')} ORDER BY ${sessions_SESSION_OCCURRED_AT} DESC,${across ? ' s.project_id DESC,' : ''} s.session_id DESC LIMIT ?`).bind(...[...params,k.limit+1])
      .all<Record<string, unknown>>();
    return results;
  })();
  const received = await read('receipt', walks);
  // An activity window judged at an instant also lists the sessions working now, read apart through the index that
  // holds them alone, and merged into the page in its own order.
  const working = active && opts.now !== undefined ? await read('working', sessions_SESSIONS_WORKING_INDEX) : [];
  const rows = sessions_mergeSessionPages(received, working).map((row) => ({ ...sessions_toSession(row, opts.now), projectId: row.project_id as string }));
  // The cursor carries the same value the sort ordered by. Both columns are
  // already on the row, so this is the SQL COALESCE read back rather than a
  // second definition of it.
  return across
    ? sessions_import_projectPage(rows, k.limit, (r) => ({ createdAt: r.startedAt ?? r.firstReceivedAt, projectId: r.projectId, id: r.sessionId }))
    : sessions_import_page(rows, k.limit, (r) => ({ createdAt: r.startedAt ?? r.firstReceivedAt, id: r.sessionId }));
}

/** Two pages of session rows as one, each session once, in the order a page reads: newest occurrence first, then Project, then id. */
const descending = (x: string, y: string): number => (x < y ? 1 : x === y ? 0 : -1);

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
  const row = await db.prepare(`SELECT agent, started_at, ended_at, ended_by, occurred_started_at, occurred_ended_at,
    first_received_at, last_received_at FROM sessions WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId).first<{
      agent: string | null; started_at: number | null; ended_at: number | null; ended_by: string | null;
      occurred_started_at: number | null; occurred_ended_at: number | null; first_received_at: number; last_received_at: number;
    }>();
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
  const row = await db.prepare(`SELECT s.machine_id, s.created_by_token_id, s.started_at, s.ended_at, s.first_received_at
                FROM sessions s WHERE s.project_id = ? AND s.session_id = ? AND ${sessions_LIVE_SESSION}`)
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  return row === null ? null : {
    machineId: sessions_text(row.machine_id),
    createdByTokenId: row.created_by_token_id as string,
    startedAt: sessions_num(row.started_at),
    endedAt: sessions_num(row.ended_at),
    firstReceivedAt: row.first_received_at as number,
  };
}

/** The counts a list shows beside each session: the counters its document's catalog row keeps. */
type sessions_ListCounts = Omit<sessions_SessionCounts, 'attachments'>;

/** The catalog counters of every named session, one statement per run of ids; a session with no live document counts zero. */
async function sessions_sessionCountsFor(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Map<string, sessions_ListCounts>> {
  const read = sessions_countStatements(db, scope, sessionIds);
  return read.parse(read.statements.length === 0 ? [] : await db.batch(read.statements));
}

/** The statements `sessionCountsFor` sends, and how their results read, so a caller may send them in a batch of its own. */
function sessions_countStatements(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): { statements: sessions_import_PreparedStatement[]; parse: (results: readonly sessions_import_RunResult[]) => Promise<Map<string, sessions_ListCounts>> } {
  const statements = sessions_import_inListChunks(sessionIds).map(ids => db.prepare(`SELECT d.session_id, d.prompts, d.tool_calls, d.replies, d.plans
    FROM session_documents d WHERE d.project_id = ? AND d.session_id IN (SELECT value FROM json_each(?)) AND d.state = 'live'`).bind(scope.projectId, JSON.stringify(ids)));
  return { statements, parse: async results => {
    const out = new Map<string, sessions_ListCounts>(sessionIds.map(id => [id, { prompts: 0, toolCalls: 0, responses: 0, plans: 0 }]));
    for (const result of results) for (const row of result.results as Record<string, unknown>[]) out.set(String(row.session_id), {
      prompts: Number(row.prompts), toolCalls: Number(row.tool_calls), responses: Number(row.replies), plans: Number(row.plans),
    });
    return out;
  } };
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
  const reads = [...byProject].map(([projectId, ids]) => ({ projectId, counts: sessions_countStatements(db, { projectId }, ids) }));
  const statements = reads.flatMap((r) => r.counts.statements);
  const results = statements.length === 0 ? [] : await db.batch(statements);
  const counts = new Map<string, Map<string, sessions_ListCounts>>();
  let at = 0;
  for (const read of reads) counts.set(read.projectId, await read.counts.parse(results.slice(at, at += read.counts.statements.length)));
  return {
    cursor: listed.cursor,
    rows: listed.rows.map((row) => {
      const c = counts.get(row.projectId)?.get(row.sessionId);
      return { ...row, promptCount: c?.prompts ?? 0, toolCallCount: c?.toolCalls ?? 0 };
    }),
  };
}

/** What the project holds, one count per projection: they share no key, and a join would multiply rows. */
async function sessions_projectStats(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, nowMs: number): Promise<sessions_ProjectStats> {
  const sessions = await db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${sessions_PRESENTED_ENDED_AT} IS NULL THEN 1 ELSE 0 END) AS open,
                     SUM(CASE WHEN ${sessions_SESSION_OCCURRED_AT} >= ? THEN 1 ELSE 0 END) AS recent, MAX(last_received_at) AS last
                FROM sessions s WHERE s.project_id = ? AND ${sessions_LIVE_SESSION}`)
    .bind(nowMs - sessions_WEEK_MS, scope.projectId)
    .first<Record<string, unknown>>();
  const countOf = async (table: string): Promise<number> => {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(scope.projectId).first<{ n: number }>();
    return row?.n ?? 0;
  };
  const totals = await db.prepare(`SELECT COALESCE(SUM(prompts), 0) AS prompts, COALESCE(SUM(tool_calls), 0) AS tool_calls
    FROM session_documents WHERE project_id = ? AND state = 'live'`).bind(scope.projectId).first<Record<string, number>>();
  return {
    sessions: (sessions?.total as number | null) ?? 0,
    openSessions: (sessions?.open as number | null) ?? 0,
    sessionsLast7d: (sessions?.recent as number | null) ?? 0,
    prompts: Number(totals?.prompts ?? 0),
    toolCalls: Number(totals?.tool_calls ?? 0),
    plans: await countOf('plans'),
    attachments: await countOf('attachments'),
    lastActivityAt: (sessions?.last as number | null) ?? null,
  };
}

/** True when the project exists. The core answers what is there; a facade decides whether its caller may see it. */
async function sessions_projectExists(db: sessions_import_RelationalStore, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM projects WHERE project_id = ?`).bind(projectId).first<{ present: number }>();
  return row !== null;
}

/** Which of these Project ids name a Project, in one statement. At most `MAX_IN_LIST` ids. */
async function sessions_existingProjects(db: sessions_import_RelationalStore, projectIds: readonly string[]): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const { results } = await db.prepare(`SELECT project_id FROM projects WHERE project_id IN (${projectIds.map(() => '?').join(', ')})`)
    .bind(...projectIds)
    .all<{ project_id: string }>();
  return new Set(results.map((r) => r.project_id));
}

/** True when the session exists inside the scope. `sessions` is keyed `(project_id, session_id)`, so containment is the only safe question to ask of a session id. */
async function sessions_sessionInScope(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/**
 * True when the session sits inside the scope and the named machine holds it.
 *
 * One question, one answer: a session another machine captured reads the same
 * as one the Project never held, so a caller naming an id it does not own
 * learns nothing about whether that id exists.
 */
async function sessions_sessionHeldByMachine(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, machineId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND machine_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, machineId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** True when the Project holds this session, whichever machine captured it: what a run's dispatch-named session is checked against before a write names it. */
async function sessions_projectHoldsSession(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ? AND ${sessions_import_NOT_TOMBSTONED_PARAMS}`)
    .bind(scope.projectId, sessionId, scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** Whether a session inside the scope carries a title. The row a titling run owed, as the store holds it. */
async function sessions_sessionCarriesTitle(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS one FROM sessions WHERE project_id = ? AND session_id = ? AND title IS NOT NULL`)
    .bind(scope.projectId, sessionId)
    .first<{ one: number }>();
  return row !== null;
}

/** Which of these sessions the Project holds a row for, whatever their state. */
async function sessions_heldSessionIds(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await db.prepare(`SELECT session_id FROM sessions WHERE project_id = ? AND session_id IN (${run.map(() => '?').join(', ')})`)
      .bind(scope.projectId, ...run)
      .all<{ session_id: string }>();
    for (const r of results) out.add(r.session_id);
  }
  return out;
}

/** Sessions whose original facts were recorded by a named importer. */
async function sessions_sessionsOwnedByImporter(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await db.prepare(`SELECT s.session_id FROM sessions s JOIN events e ON e.project_id = s.project_id AND e.event_id = s.facts_event_id
       WHERE s.project_id = ? AND s.session_id IN (${run.map(() => '?').join(', ')}) AND e.channel = 'import' AND e.producer_adapter = ?
         AND NOT EXISTS (SELECT 1 FROM events live WHERE live.project_id = s.project_id AND live.session_id = s.session_id
           AND live.channel <> 'import' AND live.kind IN ('session.start', 'session.end', 'transcript.segment'))`).bind(scope.projectId, ...run, producer).all<{ session_id: string }>();
    for (const row of results) out.add(row.session_id);
  }
  return out;
}

/** Which of these sessions hold a prompt `producer` sent on the import channel. */
const sessions_IMPORTED_PROMPT_SESSIONS_SQL = `SELECT offered.value AS session_id FROM json_each(?) offered
  WHERE EXISTS (SELECT 1 FROM events e WHERE e.project_id = ? AND e.session_id = offered.value
    AND e.kind = 'prompt' AND e.channel = 'import' AND e.producer_adapter = ?)`;

async function sessions_sessionsWithImportedPrompts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionIds: readonly string[], producer: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const run of sessions_import_inListChunks(sessionIds)) {
    const { results } = await db.prepare(sessions_IMPORTED_PROMPT_SESSIONS_SQL)
      .bind(JSON.stringify(run), scope.projectId, producer)
      .all<{ session_id: string }>();
    for (const r of results) out.add(r.session_id);
  }
  return out;
}

/** One session inside the scope, or null — including when the session exists under another project. */
/** One session; given `nowMs`, marked working or not. */
 async function sessions_getSession(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string, nowMs?: number): Promise<sessions_SessionRow | null> {
  const row = (await queryRows<Record<string, unknown>>(db,`SELECT ${sessions_SESSION_COLUMNS} ${sessions_SESSION_FROM} WHERE s.project_id = ? AND s.session_id = ? AND ${sessions_LIVE_SESSION}`,[scope.projectId, sessionId],'first'))[0] ?? null;
  return row === null ? null : sessions_toSession(row, nowMs);
}

/** How many of each child a session holds. One statement per table rather than a join: the projections have no common key and a five-way LEFT JOIN would multiply rows. */
 async function sessions_sessionCounts(db: sessions_import_RelationalStore, scope: sessions_import_ReadScope, sessionId: string): Promise<sessions_SessionCounts> {
  const row = await db.prepare(`SELECT d.prompts, d.tool_calls toolCalls, d.replies responses, d.plans,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id=d.project_id AND a.session_id=d.session_id) attachments
    FROM session_documents d WHERE d.project_id=? AND d.session_id=? AND d.state='live'
      AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)`)
    .bind(scope.projectId, sessionId).first<sessions_SessionCounts>();
  return row ?? { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 };
}

export function prepareRestoredSessionUnread(db: sessions_import_RelationalStore, sessions: string) {
  return db.prepare(`UPDATE session_read_facts SET eligible_prompts =
  ${sessionDocumentUnreadSql('session_read_facts.project_id','session_read_facts.session_id')}
  WHERE (project_id, session_id) IN (SELECT json_extract(value, '$.projectId'), json_extract(value, '$.sessionId') FROM json_each(?))`).bind(sessions);
}

export { type sessions_ProjectRow, type sessions_SessionRow, type sessions_ProjectStats, type sessions_SessionCounts, sessions_FIRST_PROMPT_CHARS, sessions_LABEL_MAX_CHARS, sessions_UNTITLED_SESSION_LABEL, sessions_sessionLabel, sessions_relatedSessionLabel, sessions_PRESENTED_STARTED_AT, sessions_PRESENTED_ENDED_AT, sessions_SESSIONS_ACROSS_INDEX, sessions_SESSIONS_ACTIVE_INDEX, sessions_SESSIONS_WORKING_INDEX, sessions_WORKING_CAP_MS, sessions_listProjectsSql, sessions_listProjects, type sessions_ArchiveOutcome, type sessions_UnarchiveOutcome, type sessions_SessionFilters, sessions_SESSION_OCCURRED_AT, sessions_listSessions, sessions_listSessionsAcross, sessions_getSession, sessions_sessionDurationMs, type sessions_SessionLifecycle, sessions_sessionLifecycle, sessions_sessionCounts, sessions_sessionCountsFor, type sessions_SessionSummaryRow, sessions_listSessionSummaries, type sessions_SessionAcrossRow, sessions_listSessionSummariesAcross, sessions_projectStats, sessions_projectExists, sessions_existingProjects, sessions_sessionInScope, sessions_sessionHeldByMachine, sessions_projectHoldsSession, sessions_sessionCarriesTitle, sessions_heldSessionIds, sessions_sessionsOwnedByImporter, sessions_sessionsWithImportedPrompts, sessions_FIRST_PROMPT_SQL, sessions_firstPromptSql };
