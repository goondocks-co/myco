import type { RelationalStore } from '../../core/adapters.js';
import { jsonKeys } from '../ddl.js';
import { read, readSet, write, type Bound } from '../index.js';
import { planStatusTotals } from '../plans/counts.js';
import type { CatchupFamily } from '../projections/family.js';
import {
  DAY_MS,
  PROJECT_STATISTICS_ATTACHMENT_PHASE,
  PROJECT_STATISTICS_PROJECTION,
  PROJECT_STATISTICS_SESSION_PHASE,
  reconcileAttachmentCounts,
  reconcileSessionStatistics,
} from './statistics-schema.js';

/** The days a recent total covers: today in UTC and the six before it. */
const RECENT_DAYS = 7;

const pageKeys = jsonKeys(['project_id', 'session_id']);
const pageStatements = (name: string, sql: readonly string[]) => sql.map((text, i) => write<[string]>({ name: `projectStatistics.${name}${i}`, sql: text }));

const clearSessions = write<[]>({ name: 'projectStatistics.clearSessions', sql: 'DELETE FROM session_statistics' });
const clearAttachments = write<[]>({ name: 'projectStatistics.clearAttachments', sql: 'DELETE FROM session_attachment_counts' });
const clearDays = write<[]>({ name: 'projectStatistics.clearDays', sql: 'DELETE FROM project_session_days' });
const clearCounters = write<[]>({ name: 'projectStatistics.clearCounters', sql: 'UPDATE project_session_counts SET open_sessions=0,prompts=0,tool_calls=0,attachments=0' });

/** Every session key and every key holding an attachment, re-derived page by page; restarting drops what a replay would not overwrite. */
export const PROJECT_STATISTICS_CATCHUP = {
  projection: PROJECT_STATISTICS_PROJECTION,
  phases: {
    [PROJECT_STATISTICS_SESSION_PHASE]: { source: { table: 'sessions', columns: ['project_id', 'session_id'], unique: true }, reconcile: pageStatements('sessionPage', reconcileSessionStatistics(pageKeys)) },
    [PROJECT_STATISTICS_ATTACHMENT_PHASE]: { source: { table: 'attachments', columns: ['project_id', 'session_id'] }, reconcile: pageStatements('attachmentPage', reconcileAttachmentCounts(pageKeys)) },
  },
  reset: (): Bound[] => [clearSessions.bind(), clearAttachments.bind(), clearDays.bind(), clearCounters.bind()],
} as const satisfies CatchupFamily;

interface ProjectCounters {
  session_count: number; open_sessions: number; prompts: number; tool_calls: number; attachments: number;
}

const phases = read<[], { done: number }>({ name: 'projectStatistics.phases', sql: `SELECT done FROM projection_catchup WHERE projection='${PROJECT_STATISTICS_PROJECTION}'` });
const counters = read<[project: string], ProjectCounters>({ name: 'projectStatistics.counters',
  sql: 'SELECT session_count,open_sessions,prompts,tool_calls,attachments FROM project_session_counts WHERE project_id=?1' });
const recentDays = read<[project: string, from: number], { n: number }>({ name: 'projectStatistics.recentDays', sql: 'SELECT n FROM project_session_days WHERE project_id=?1 AND day>=?2' });
const lastActivity = read<[project: string], { last_received_at: number }>({ name: 'projectStatistics.lastActivity',
  sql: `SELECT last_received_at FROM session_read_facts WHERE project_id=?1 AND has_session=1 AND tombstoned=0 ORDER BY last_received_at DESC LIMIT 1` });

/** What a Project holds, counted for its home page. */
export interface ProjectStatistics {
  sessions: number;
  /** Sessions with no end recorded. A runtime that died never ends its session, so this is what the data says, not a liveness claim. */
  openSessions: number;
  /** Sessions started on today's UTC day or the six before it. */
  sessionsLast7d: number;
  prompts: number;
  toolCalls: number;
  /** Null while plan contributions are being counted or retired. */
  plans: number | null;
  attachments: number;
  lastActivityAt: number | null;
}

/** The statistics of a Project, from its counters; `building` until existing sessions and attachments have been counted. */
export type ProjectStatisticsAnswer = { state: 'building' } | ({ state: 'ready' } & ProjectStatistics);

/** One Project's statistics in a fixed number of small reads, whatever it holds. */
export async function projectStatistics(db: RelationalStore, projectId: string, nowMs: number): Promise<ProjectStatisticsAnswer> {
  const today = Math.floor(nowMs / DAY_MS);
  const [held, plans] = await Promise.all([
    readSet(db, phases.bind(), counters.bind(projectId), recentDays.bind(projectId, today - RECENT_DAYS + 1), lastActivity.bind(projectId)),
    planStatusTotals(db, { projectId }),
  ]);
  const [done, count, days, last] = held;
  if (done.length !== Object.keys(PROJECT_STATISTICS_CATCHUP.phases).length || done.some(phase => phase.done !== 1)) return { state: 'building' };
  const row = count[0];
  return {
    state: 'ready',
    sessions: row?.session_count ?? 0,
    openSessions: row?.open_sessions ?? 0,
    sessionsLast7d: days.reduce((sum, day) => sum + day.n, 0),
    prompts: row?.prompts ?? 0,
    toolCalls: row?.tool_calls ?? 0,
    plans: plans.state === 'ready' ? Object.values(plans.value).reduce((sum, n) => sum + n, 0) : null,
    attachments: row?.attachments ?? 0,
    lastActivityAt: last[0]?.last_received_at ?? null,
  };
}
