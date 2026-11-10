import { write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger } from '../ddl.js';
import { occurredAt } from '../session-dates.js';
import type { CatchupFamily, CatchupPhase } from '../projections/family.js';

/**
 * A Project's activity feed as one maintained relation: one `project_activity` row per session, run, active spore and
 * plan the feed shows, keyed by its kind and source and ordered by `(sort_at, kind, source_id)`. Every row is
 * re-derived from its source whenever a trigger on that source (or on a session's tombstone) or a catch-up page names
 * its key, so the feed follows corrections, retirements and deletions in the statement that makes them, and a page is
 * one index seek however much history the Project holds.
 *
 * A session row carries no preview: its label is read with the page, from the session itself.
 */
export const ACTIVITY_PROJECTION = 'project_activity';

/** The kinds the feed shows, each derived from one source table. */
export const ACTIVITY_KINDS = ['plan', 'run', 'session', 'spore'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];

/** How many characters of a spore's body its feed line keeps. */
const SPORE_PREVIEW_CHARS = 80;

interface ActivitySource {
  kind: ActivityKind;
  table: string;
  /** The source's own key column beside `project_id`. */
  id: string;
  /** The catch-up phase that adds existing rows. */
  phase: string;
  /** When the source row is shown at all, over alias `s`. */
  shown: string;
  sortAt: string;
  preview: string;
  sessionId: string;
}

const notTombstoned = (session: string) =>
  `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=s.project_id AND t.session_id=${session})`;

const SOURCES: Readonly<Record<ActivityKind, ActivitySource>> = {
  session: { kind: 'session', table: 'sessions', id: 'session_id', phase: 'activitySessions', shown: notTombstoned('s.session_id'),
    sortAt: occurredAt('s.'), preview: 'NULL', sessionId: 's.session_id' },
  run: { kind: 'run', table: 'agent_runs', id: 'id', phase: 'activityRuns', shown: 'COALESCE(s.resumed_at,s.started_at,s.completed_at,s.queued_at) IS NOT NULL',
    sortAt: 'COALESCE(s.resumed_at,s.started_at,s.completed_at,s.queued_at)', preview: "COALESCE(s.task,'run') || ' — ' || s.status", sessionId: 'NULL' },
  spore: { kind: 'spore', table: 'spores', id: 'id', phase: 'activitySpores', shown: "s.status='active'",
    sortAt: 's.created_at', preview: `s.observation_type || ': ' || substr(s.content,1,${SPORE_PREVIEW_CHARS})`, sessionId: 's.session_id' },
  plan: { kind: 'plan', table: 'plans', id: 'plan_key', phase: 'activityPlans', shown: notTombstoned('s.session_id'),
    sortAt: 's.updated_at', preview: 's.title', sessionId: 's.session_id' },
};

/** Re-derive the rows of one kind for the keys `keys` (columns `project_id,source_id`): a source no longer shown loses its row. */
function reconcile(source: ActivitySource, keys: string): string[] {
  const derived = ['sort_at', 'preview', 'session_id'];
  return [
    `DELETE FROM project_activity WHERE (project_id,kind,source_id) IN (SELECT project_id,'${source.kind}',source_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM ${source.table} s WHERE s.project_id=project_activity.project_id AND s.${source.id}=project_activity.source_id AND ${source.shown})`,
    `INSERT INTO project_activity(project_id,kind,source_id,sort_at,preview,session_id)
      SELECT s.project_id,'${source.kind}',s.${source.id},${source.sortAt},${source.preview},${source.sessionId}
      FROM (${keys}) key JOIN ${source.table} s ON s.project_id=key.project_id AND s.${source.id}=key.source_id WHERE ${source.shown}
      ON CONFLICT(project_id,kind,source_id) DO UPDATE SET ${derived.map(c => `${c}=excluded.${c}`).join(',')}
        WHERE (${derived.map(c => `project_activity.${c}`).join(',')}) IS NOT (${derived.map(c => `excluded.${c}`).join(',')})`,
  ];
}

/** The columns of each source whose change moves, relabels, shows or hides its feed row. */
const WATCHED: Readonly<Record<ActivityKind, readonly string[]>> = {
  session: ['project_id', 'session_id', 'occurred_started_at', 'started_at', 'first_received_at'],
  run: ['project_id', 'id', 'resumed_at', 'started_at', 'completed_at', 'queued_at', 'task', 'status'],
  spore: ['project_id', 'id', 'status', 'observation_type', 'content', 'created_at', 'session_id'],
  plan: ['project_id', 'plan_key', 'updated_at', 'title', 'session_id'],
};

const PAGE_KEYS = jsonKeys(['project_id', 'source_id']);

const phase = (source: ActivitySource): CatchupPhase => ({
  source: { table: source.table, columns: ['project_id', source.id], unique: true },
  reconcile: reconcile(source, PAGE_KEYS).map((sql, i) => write<[string]>({ name: `projectActivity.${source.phase}${i}`, sql })),
});

/** One catch-up phase per source: each page re-derives its keys' rows inside the caller's commit. */
export const ACTIVITY_CATCHUP = {
  projection: ACTIVITY_PROJECTION,
  phases: {
    activitySessions: phase(SOURCES.session), activityRuns: phase(SOURCES.run), activitySpores: phase(SOURCES.spore), activityPlans: phase(SOURCES.plan),
  },
} as const satisfies CatchupFamily;

/** The relation, its feed index, the triggers on every source and on session tombstones, and the catch-up seeds. */
export function projectActivitySchemaStatements(): string[] {
  const triggers = Object.values(SOURCES).flatMap(source => {
    const key = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.${source.id} AS source_id`;
    const name = `project_activity_${source.kind}`;
    return [
      trigger(`${name}_insert`, source.table, 'INSERT', reconcile(source, key('NEW'))),
      trigger(`${name}_update`, source.table, `UPDATE OF ${WATCHED[source.kind].join(',')}`,
        [...reconcile(source, key('OLD')), ...reconcile(source, key('NEW'))], changed(WATCHED[source.kind])),
      trigger(`${name}_delete`, source.table, 'DELETE', reconcile(source, key('OLD'))),
    ];
  });
  // A session's tombstone hides it and its plans from the feed, and lifting the tombstone shows them again.
  const hidden = (row: string) => [
    ...reconcile(SOURCES.session, `SELECT ${row}.project_id AS project_id,${row}.session_id AS source_id`),
    ...reconcile(SOURCES.plan, `SELECT p.project_id AS project_id,p.plan_key AS source_id FROM plans p WHERE p.project_id=${row}.project_id AND p.session_id=${row}.session_id`),
  ];
  return [
    `CREATE TABLE IF NOT EXISTS project_activity(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),kind TEXT NOT NULL,source_id TEXT NOT NULL,
      sort_at INTEGER NOT NULL,preview TEXT,session_id TEXT,PRIMARY KEY(project_id,kind,source_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_project_activity_feed ON project_activity(project_id,sort_at,kind,source_id)',
    ...triggers.map(t => t.sql),
    trigger('project_activity_tombstone_insert', 'session_tombstones', 'INSERT', hidden('NEW')).sql,
    trigger('project_activity_tombstone_delete', 'session_tombstones', 'DELETE', hidden('OLD')).sql,
    ...Object.values(SOURCES).map(source => `INSERT INTO projection_catchup(projection,phase,done)
      SELECT '${ACTIVITY_PROJECTION}','${source.phase}',NOT EXISTS(SELECT 1 FROM ${source.table})`),
  ];
}
