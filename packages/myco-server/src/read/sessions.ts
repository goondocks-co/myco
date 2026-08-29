import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

export interface ProjectRow {
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
export interface SessionRow {
  sessionId: string;
  machineId: string | null;
  createdByTokenId: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  originPath: string | null;
  parentSessionId: string | null;
  parentReason: string | null;
  /** The member and runtime behind the credential that captured the session; null when the credential row is gone. */
  memberId: string | null;
  memberLabel: string | null;
  runtimeLabel: string | null;
  runtimeKind: string | null;
}

/** What a project holds, counted for its home page. */
export interface ProjectStats {
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
export interface SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

/** Both joins land on primary keys, so the row count and the order are those of `sessions` alone. */
const SESSION_COLUMNS = `s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, s.started_at, s.ended_at, s.origin_path, s.parent_session_id, s.parent_reason,
     c.member_id, c.runtime_label, c.runtime_kind, m.label AS member_label`;
const SESSION_FROM = `FROM sessions s
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id`;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const text = (value: unknown): string | null => (value as string | null) ?? null;
const num = (value: unknown): number | null => (value as number | null) ?? null;

function toSession(row: Record<string, unknown>): SessionRow {
  return {
    sessionId: row.session_id as string,
    machineId: text(row.machine_id),
    createdByTokenId: row.created_by_token_id as string,
    firstReceivedAt: row.first_received_at as number,
    lastReceivedAt: row.last_received_at as number,
    agent: text(row.agent),
    branch: text(row.branch),
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    originPath: text(row.origin_path),
    parentSessionId: text(row.parent_session_id),
    parentReason: text(row.parent_reason),
    memberId: text(row.member_id),
    memberLabel: text(row.member_label),
    runtimeLabel: text(row.runtime_label),
    runtimeKind: text(row.runtime_kind),
  };
}

/** Every project with its session count and most recent receipt, most recently active first. Unscoped: the caller decides which projects its credential may see. */
export async function listProjects(db: RelationalStore, opts: { includeArchived?: boolean } = {}): Promise<ProjectRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.project_id, p.name, p.created_at, p.archived_at, p.archived_by,
              COUNT(s.session_id) AS session_count,
              MAX(s.last_received_at) AS last_activity_at
         FROM projects p LEFT JOIN sessions s ON s.project_id = p.project_id
        ${opts.includeArchived === true ? '' : 'WHERE p.archived_at IS NULL'}
        GROUP BY p.project_id, p.name, p.created_at, p.archived_at, p.archived_by
        ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC`
    )
    .all<Record<string, unknown>>();
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

export type ArchiveOutcome = 'archived' | 'absent' | 'already_archived';
export type UnarchiveOutcome = 'restored' | 'absent' | 'not_archived';

/** Archive a project: capture is refused from here on, listings hide it by default, and everything captured stays. One statement moves it; a read tells an absent project from one already archived. */
export async function archiveProject(db: RelationalStore, projectId: string, by: string, nowMs: number): Promise<ArchiveOutcome> {
  const result = await db
    .prepare(`UPDATE projects SET archived_at = ?, archived_by = ? WHERE project_id = ? AND archived_at IS NULL`)
    .bind(nowMs, by, projectId)
    .run();
  if (result.meta.changes === 1) return 'archived';
  return (await projectExists(db, projectId)) ? 'already_archived' : 'absent';
}

/** Restore capture for an archived project. */
export async function unarchiveProject(db: RelationalStore, projectId: string): Promise<UnarchiveOutcome> {
  const result = await db
    .prepare(`UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE project_id = ? AND archived_at IS NOT NULL`)
    .bind(projectId)
    .run();
  if (result.meta.changes === 1) return 'restored';
  return (await projectExists(db, projectId)) ? 'not_archived' : 'absent';
}

/** A project's sessions, most recently started first, over `idx_sessions_recent`. The key is `first_received_at` paired with `session_id`: a keyset page must order by a column no later write moves, or an actively capturing session slips above the cursor between two pages and appears on neither. */
export interface SessionFilters {
  branch?: string;
  /** Sessions started at or after this instant (ms). */
  since?: number;
  /** `open` is a session with no end recorded; `ended` one with an end. */
  state?: 'open' | 'ended';
  /** The label of the member whose credential captured the session. */
  memberLabel?: string;
  sessionId?: string;
}

export async function listSessions(db: RelationalStore, scope: ReadScope, opts: { limit?: number; cursor?: string } & SessionFilters = {}): Promise<Page<SessionRow>> {
  const k = keyset(opts, { order: 's.first_received_at', id: 's.session_id', direction: 'DESC' });
  if (k === null) return { rows: [], cursor: null };
  const conditions = ['s.project_id = ?'];
  const params: unknown[] = [scope.projectId];
  if (opts.branch !== undefined) { conditions.push('s.branch = ?'); params.push(opts.branch); }
  if (opts.since !== undefined) { conditions.push('s.started_at >= ?'); params.push(opts.since); }
  if (opts.state === 'open') conditions.push('s.ended_at IS NULL');
  if (opts.state === 'ended') conditions.push('s.ended_at IS NOT NULL');
  if (opts.memberLabel !== undefined) { conditions.push('m.label = ?'); params.push(opts.memberLabel); }
  if (opts.sessionId !== undefined) { conditions.push('s.session_id = ?'); params.push(opts.sessionId); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const { results } = await db
    .prepare(`SELECT ${SESSION_COLUMNS} ${SESSION_FROM} WHERE ${conditions.join(' AND ')} ORDER BY s.first_received_at DESC, s.session_id DESC LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  return page(results.map(toSession), k.limit, (r) => ({ createdAt: r.firstReceivedAt, id: r.sessionId }));
}

/** One session inside the scope, or null — including when the session exists under another project. */
export async function getSession(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionRow | null> {
  const row = await db
    .prepare(`SELECT ${SESSION_COLUMNS} ${SESSION_FROM} WHERE s.project_id = ? AND s.session_id = ?`)
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  return row === null ? null : toSession(row);
}

/** How many of each child a session holds. One statement per table rather than a join: the projections have no common key and a five-way LEFT JOIN would multiply rows. */
export async function sessionCounts(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionCounts> {
  const tables = [
    ['prompts', 'prompt_batches'],
    ['toolCalls', 'tool_calls'],
    ['responses', 'responses'],
    ['plans', 'plans'],
    ['attachments', 'attachments'],
  ] as const;
  const counts = {} as Record<string, number>;
  for (const [key, table] of tables) {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ? AND session_id = ?`)
      .bind(scope.projectId, sessionId)
      .first<{ n: number }>();
    counts[key] = row?.n ?? 0;
  }
  return counts as unknown as SessionCounts;
}

/** The child counts of every named session, one statement per table for the whole set; a session with no rows in a table counts zero. */
export async function sessionCountsFor(db: RelationalStore, scope: ReadScope, sessionIds: readonly string[]): Promise<Map<string, SessionCounts>> {
  const out = new Map<string, SessionCounts>(sessionIds.map((id) => [id, { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 }]));
  if (sessionIds.length === 0) return out;
  const tables = [['prompts', 'prompt_batches'], ['toolCalls', 'tool_calls'], ['responses', 'responses'], ['plans', 'plans'], ['attachments', 'attachments']] as const;
  const placeholders = sessionIds.map(() => '?').join(', ');
  const results = await db.batch(tables.map(([, table]) =>
    db.prepare(`SELECT session_id, COUNT(*) AS n FROM ${table} WHERE project_id = ? AND session_id IN (${placeholders}) GROUP BY session_id`).bind(scope.projectId, ...sessionIds)));
  tables.forEach(([key], i) => {
    for (const row of results[i].results as { session_id: string; n: number }[]) {
      const counts = out.get(row.session_id);
      if (counts) counts[key] = row.n;
    }
  });
  return out;
}

/** What the project holds, one count per projection: they share no key, and a join would multiply rows. */
export async function projectStats(db: RelationalStore, scope: ReadScope, nowMs: number): Promise<ProjectStats> {
  const sessions = await db
    .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open,
                     SUM(CASE WHEN first_received_at >= ? THEN 1 ELSE 0 END) AS recent, MAX(last_received_at) AS last
                FROM sessions WHERE project_id = ?`)
    .bind(nowMs - WEEK_MS, scope.projectId)
    .first<Record<string, unknown>>();
  const countOf = async (table: string): Promise<number> => {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`).bind(scope.projectId).first<{ n: number }>();
    return row?.n ?? 0;
  };
  return {
    sessions: (sessions?.total as number | null) ?? 0,
    openSessions: (sessions?.open as number | null) ?? 0,
    sessionsLast7d: (sessions?.recent as number | null) ?? 0,
    prompts: await countOf('prompt_batches'),
    toolCalls: await countOf('tool_calls'),
    plans: await countOf('plans'),
    attachments: await countOf('attachments'),
    lastActivityAt: (sessions?.last as number | null) ?? null,
  };
}

/** True when the project exists. The core answers what is there; a facade decides whether its caller may see it. */
export async function projectExists(db: RelationalStore, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM projects WHERE project_id = ?`).bind(projectId).first<{ present: number }>();
  return row !== null;
}

/** True when the session exists inside the scope. `sessions` is keyed `(project_id, session_id)`, so containment is the only safe question to ask of a session id. */
export async function sessionInScope(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** Insert a project, answering false when one already carries the id. */
export async function createProject(db: RelationalStore, projectId: string, name: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`)
    .bind(projectId, name, nowMs)
    .run();
  return result.meta.changes === 1;
}
