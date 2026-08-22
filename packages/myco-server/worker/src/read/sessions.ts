import type { D1Like } from '../env.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from './scope.js';

export interface ProjectRow {
  projectId: string;
  name: string;
  createdAt: number;
  sessionCount: number;
  lastActivityAt: number | null;
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
}

/** Counts of a session's child projections, for a detail view that shows what it holds before fetching any of it. */
export interface SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

const SESSION_COLUMNS = `session_id, machine_id, created_by_token_id, first_received_at, last_received_at,
     agent, branch, started_at, ended_at, origin_path, parent_session_id, parent_reason`;

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
  };
}

/** Every project with its session count and most recent receipt, most recently active first. Unscoped: the caller decides which projects its credential may see. */
export async function listProjects(db: D1Like): Promise<ProjectRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.project_id, p.name, p.created_at,
              COUNT(s.session_id) AS session_count,
              MAX(s.last_received_at) AS last_activity_at
         FROM projects p LEFT JOIN sessions s ON s.project_id = p.project_id
        GROUP BY p.project_id, p.name, p.created_at
        ORDER BY last_activity_at DESC NULLS LAST, p.created_at DESC`
    )
    .all<Record<string, unknown>>();
  return results.map((row) => ({
    projectId: row.project_id as string,
    name: row.name as string,
    createdAt: row.created_at as number,
    sessionCount: row.session_count as number,
    lastActivityAt: (row.last_activity_at as number | null) ?? null,
  }));
}

/** A project's sessions, most recent receipt first, over `idx_sessions_recent`. */
export async function listSessions(db: D1Like, scope: ReadScope, opts: { limit?: number; cursor?: string } = {}): Promise<Page<SessionRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const statement = after
    ? db
        .prepare(
          `SELECT ${SESSION_COLUMNS} FROM sessions
            WHERE project_id = ? AND (last_received_at < ? OR (last_received_at = ? AND session_id < ?))
            ORDER BY last_received_at DESC, session_id DESC LIMIT ?`
        )
        .bind(scope.projectId, after.createdAt, after.createdAt, after.id, limit + 1)
    : db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_id = ? ORDER BY last_received_at DESC, session_id DESC LIMIT ?`)
        .bind(scope.projectId, limit + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  return page(results.map(toSession), limit, (r) => ({ createdAt: r.lastReceivedAt, id: r.sessionId }));
}

/** One session inside the scope, or null — including when the session exists under another project. */
export async function getSession(db: D1Like, scope: ReadScope, sessionId: string): Promise<SessionRow | null> {
  const row = await db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId)
    .first<Record<string, unknown>>();
  return row === null ? null : toSession(row);
}

/** How many of each child a session holds. One statement per table rather than a join: the projections have no common key and a five-way LEFT JOIN would multiply rows. */
export async function sessionCounts(db: D1Like, scope: ReadScope, sessionId: string): Promise<SessionCounts> {
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

/** True when the project exists. The core answers what is there; a facade decides whether its caller may see it. */
export async function projectExists(db: D1Like, projectId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS present FROM projects WHERE project_id = ?`).bind(projectId).first<{ present: number }>();
  return row !== null;
}

/** True when the session exists inside the scope. `sessions` is keyed `(project_id, session_id)`, so containment is the only safe question to ask of a session id. */
export async function sessionInScope(db: D1Like, scope: ReadScope, sessionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM sessions WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId)
    .first<{ present: number }>();
  return row !== null;
}

/** Insert a project, answering false when one already carries the id. */
export async function createProject(db: D1Like, projectId: string, name: string, nowMs: number): Promise<boolean> {
  const result = await db
    .prepare(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`)
    .bind(projectId, name, nowMs)
    .run();
  return result.meta.changes === 1;
}
