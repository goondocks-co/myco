import type { RelationalStore } from '../../core/adapters.js';
import { emit } from '../../telemetry.js';
import { commit, read, readSet, write, type Bound } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * What a queued event is waiting for, as rows the publisher can look up, wake and inspect.
 *
 * Each row names a child event and the canonical prerequisite it waits on: a prompt not yet placed in the document, or
 * an event ahead of it in turn order. A reverse index on the holder, the queued event that currently holds the
 * prerequisite, lets a settled holder wake exactly its dependents; deleting a row wakes its child through a trigger,
 * so a wake is a keyed delete. The retry cause on `publish_queue` stays as the diagnostic payload.
 *
 * A prerequisite that never settles is not a row that waits forever: every row carries the queue's backoff deadline
 * and the cycle job inspects each prompt edge exactly once, from the edge itself, in bounded checkpointed hops.
 */
export const DEPENDENCY_PROJECTION = 'publication_dependencies';
export const DEPENDENCY_PHASE = 'publicationDependencies';
/** Dependents one settled holder wakes per commit; the rest continue on the session's next pass. */
export const DEPENDENCY_WAKE_PAGE = 200;
const INSPECTION_PAGE = 32;
const INSPECTION_HOPS = 64;
/** The most hops inspection follows from one edge before it settles for checking back later: a graph this long is reported as pending. */
const INSPECTION_MAX_HOPS = 4_096;
const INSPECTION_PENDING_DELAY_MS = 30 * 60_000;

/** A queued row still held by a retry cause: what the translation walks and what holds a session's publication. */
const heldWait = (alias: string) => `${alias}retry_cause IS NOT NULL AND ${alias}failure IS NULL`;

/**
 * True while this session still holds queued waits the translation has not reached. Until then an absent typed row
 * says nothing about what the session waits on, so the session's publication stops. Keyed to one session's queue;
 * other sessions keep publishing.
 */
const translationPending = read<[string, string], { held: number }>({ name: 'publication.translationPending', sql: `SELECT 1 held FROM projection_catchup c
  WHERE c.projection='${DEPENDENCY_PROJECTION}' AND c.phase='${DEPENDENCY_PHASE}' AND c.done=0
    AND EXISTS(SELECT 1 FROM publish_queue q WHERE q.project_id=?1 AND q.session_id=?2 AND ${heldWait('q.')}
      AND (c.after_key='[]' OR (?1,?2)>(json_extract(c.after_key,'$[0]'),json_extract(c.after_key,'$[1]'))
        OR ((?1,?2)=(json_extract(c.after_key,'$[0]'),json_extract(c.after_key,'$[1]')) AND (q.rank,q.created_at,q.event_id)>(json_extract(c.after_key,'$[2]'),json_extract(c.after_key,'$[3]'),json_extract(c.after_key,'$[4]'))))
      AND (c.frontier IS NULL OR (?1,?2)<(json_extract(c.frontier,'$[0]'),json_extract(c.frontier,'$[1]'))
        OR ((?1,?2)=(json_extract(c.frontier,'$[0]'),json_extract(c.frontier,'$[1]')) AND (q.rank,q.created_at,q.event_id)<=(json_extract(c.frontier,'$[2]'),json_extract(c.frontier,'$[3]'),json_extract(c.frontier,'$[4]')))))` });
export const dependencyTranslationPending = (project: string, session: string) => translationPending.bind(project, session);

/** A session whose queued waits are still being translated: its pass waits, and every other session's continues. */
export class PublicationDependenciesBuilding extends Error {
  constructor() { super('publication_dependencies_building'); }
}

interface HeldRow { id: string; wait: string | null }
const held = read<[string, string, string, number, string], HeldRow>({ name: 'publication.heldPrerequisites', sql: `
  WITH wanted(id) AS MATERIALIZED (SELECT value FROM json_each(?3) WHERE NOT EXISTS (SELECT 1 FROM session_prompts p
    WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=?4 AND p.prompt_id=json_each.value))
  SELECT id,(SELECT json_array(q.event_id,q.retry_at) FROM event_refs r CROSS JOIN events e CROSS JOIN publish_queue q
      WHERE r.project_id=?1 AND r.session_id=?2 AND r.kind='prompt' AND r.record_id=wanted.id AND r.record_id IS NOT NULL
        AND e.project_id=r.project_id AND e.event_id=r.event_id
        AND q.project_id=r.project_id AND q.session_id=r.session_id AND q.rank=0 AND q.created_at=e.created_at AND q.event_id=r.event_id
        AND q.failure IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(?5) WHERE value=q.event_id)
      ORDER BY q.created_at,q.event_id LIMIT 1) wait FROM wanted` });

/** Which of these prompts a live queued event still holds: the earliest holder of each, unless this pass already settled it terminally. */
export async function heldPrerequisites(db: RelationalStore, project: string, session: string, generation: number, ids: readonly string[], terminal: readonly string[]) {
  const [rows] = await readSet(db, held.bind(project, session, JSON.stringify(ids), generation, JSON.stringify(terminal)));
  return rows.flatMap(row => {
    if (row.wait === null) return [];
    const [eventId, retry] = JSON.parse(row.wait) as [string, number];
    return [{ id: row.id, eventId, retry }];
  });
}

const released = read<[string, string], { child_event_id: string }>({ name: 'publication.releasedDependents',
  sql: `SELECT d.child_event_id FROM json_each(?2) j JOIN publication_dependencies d ON d.project_id=?1 AND d.child_event_id=j.value AND d.outcome='cycle'` });

/** Children whose wait the cycle job found closes a cycle: each publishes without its prerequisite. */
export async function releasedDependents(db: RelationalStore, project: string, children: readonly string[]): Promise<ReadonlySet<string>> {
  if (children.length === 0) return new Set();
  const [rows] = await readSet(db, released.bind(project, JSON.stringify(children)));
  return new Set(rows.map(row => row.child_event_id));
}

const readRoot = read<[string, string, string], { c: number; e: string; retry: number }>({ name: 'publication.earliestReadRoot',
  sql: `SELECT q.created_at c,q.event_id e,q.retry_at retry FROM publication_dependencies d CROSS JOIN publish_queue q
      ON q.project_id=d.project_id AND q.session_id=d.session_id AND q.rank=d.child_rank AND q.created_at=d.child_created_at AND q.event_id=d.child_event_id
    WHERE d.project_id=?1 AND d.session_id=?2 AND d.prerequisite_kind='read' AND q.failure IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(?3) WHERE value=d.child_event_id)
    ORDER BY d.child_created_at,d.child_event_id LIMIT 1` });

/** The earliest read-faulted root prompt holding turn order, outside this pass's own outcomes. */
export async function earliestReadRoot(db: RelationalStore, project: string, session: string, excluded: readonly string[]) {
  const [rows] = await readSet(db, readRoot.bind(project, session, JSON.stringify(excluded)));
  return rows[0] ?? null;
}

const queueKey = (json: string) => `(SELECT ?1 project_id,?2 session_id,json_extract(value,'$.r') rank,json_extract(value,'$.c') created_at,json_extract(value,'$.e') event_id FROM json_each(${json}))`;
const consumeQueue = write<[string, string, string]>({ name: 'publication.consumeQueued', sql: `DELETE FROM publish_queue WHERE (project_id,session_id,rank,created_at,event_id) IN ${queueKey('?3')}` });
const holdQueue = write<[string, string, string]>({ name: 'publication.holdQueued', sql: `UPDATE publish_queue SET
  failure=json_extract(j.value,'$.failure'),retry_at=json_extract(j.value,'$.retry'),retry_cause=json_extract(j.value,'$.cause')
  FROM json_each(?3) j WHERE project_id=?1 AND session_id=?2 AND rank=json_extract(j.value,'$.r') AND created_at=json_extract(j.value,'$.c') AND event_id=json_extract(j.value,'$.e')` });
const clearDeps = write<[string, string]>({ name: 'publication.clearDependencies', sql: `DELETE FROM publication_dependencies WHERE project_id=?1 AND child_event_id IN (SELECT value FROM json_each(?2))` });
const recordDeps = write<[string, string, number, string]>({ name: 'publication.recordDependencies', sql: `INSERT INTO publication_dependencies
    (project_id,session_id,child_event_id,child_rank,child_created_at,prerequisite_kind,prerequisite_id,holder_event_id,inspect_due)
  SELECT ?1,?2,json_extract(value,'$.e'),json_extract(value,'$.r'),json_extract(value,'$.c'),json_extract(value,'$.k'),json_extract(value,'$.p'),json_extract(value,'$.h'),
    CASE json_extract(value,'$.k') WHEN 'prompt' THEN ?3 END FROM json_each(?4) WHERE true
  ON CONFLICT(project_id,child_event_id,prerequisite_kind,prerequisite_id) DO UPDATE SET holder_event_id=excluded.holder_event_id,outcome='waiting',inspect_due=excluded.inspect_due,inspect_after=NULL,inspect_hops=0` });
const wake = write<[string, string, string]>({ name: 'publication.wakeDependents', sql: `DELETE FROM publication_dependencies WHERE (project_id,child_event_id,prerequisite_kind,prerequisite_id) IN (
    SELECT d.project_id,d.child_event_id,d.prerequisite_kind,d.prerequisite_id FROM json_each(?3) j CROSS JOIN publication_dependencies d
      ON d.project_id=?1 AND d.session_id=?2 AND d.holder_event_id=j.value
    ORDER BY d.holder_event_id,d.child_created_at,d.child_event_id LIMIT ${DEPENDENCY_WAKE_PAGE})` });
const continueWake = write<[string, string, string]>({ name: 'publication.continueWake', sql: `UPDATE session_documents SET
  publication_wake=CASE WHEN EXISTS(SELECT 1 FROM json_each(?3) j CROSS JOIN publication_dependencies d ON d.project_id=?1 AND d.session_id=?2 AND d.holder_event_id=j.value) THEN ?3 END,
  due_at=CASE WHEN EXISTS(SELECT 1 FROM json_each(?3) j CROSS JOIN publication_dependencies d ON d.project_id=?1 AND d.session_id=?2 AND d.holder_event_id=j.value) THEN 0 ELSE due_at END
  WHERE project_id=?1 AND session_id=?2 AND (publication_wake IS NOT NULL OR EXISTS(SELECT 1 FROM json_each(?3) j CROSS JOIN publication_dependencies d ON d.project_id=?1 AND d.session_id=?2 AND d.holder_event_id=j.value))` });

export const consumeQueuedStatement = (project: string, session: string, rows: string): Bound => consumeQueue.bind(project, session, rows);
export const holdQueuedStatement = (project: string, session: string, rows: string): Bound => holdQueue.bind(project, session, rows);
export const clearDependenciesStatement = (project: string, children: string): Bound => clearDeps.bind(project, children);
export const recordDependenciesStatement = (project: string, session: string, now: number, rows: string): Bound => recordDeps.bind(project, session, now, rows);
export const wakeDependentsStatement = (project: string, session: string, holders: string): Bound => wake.bind(project, session, holders);
export const continueWakeStatement = (project: string, session: string, holders: string): Bound => continueWake.bind(project, session, holders);

interface Edge { project_id: string; session_id: string; child_event_id: string; child_rank: number; child_created_at: number; prerequisite_id: string; holder_event_id: string | null; inspect_after: string | null; inspect_hops: number }
const dueEdges = read<[number], Edge>({ name: 'publication.inspectionDue', sql: `SELECT project_id,session_id,child_event_id,child_rank,child_created_at,prerequisite_id,holder_event_id,inspect_after,inspect_hops
  FROM publication_dependencies WHERE inspect_due<=?1 AND outcome='waiting' AND prerequisite_kind='prompt' ORDER BY inspect_due,project_id,child_event_id LIMIT ${INSPECTION_PAGE}` });
const walk = read<[string, string, string], { id: string; hops: number }>({ name: 'publication.inspectionWalk', sql: `WITH RECURSIVE walk(id,hops) AS (
    SELECT ?2,0 UNION ALL SELECT d.holder_event_id,w.hops+1 FROM walk w CROSS JOIN publication_dependencies d
      ON d.project_id=?1 AND d.child_event_id=w.id AND d.prerequisite_kind='prompt' AND d.holder_event_id IS NOT NULL
      WHERE w.id<>?3 AND w.hops<${INSPECTION_HOPS})
  SELECT id,hops FROM walk ORDER BY hops DESC LIMIT 1` });
const markCycle = write<[string, string, string, string | null], { session_id: string }>({ name: 'publication.markCycle', sql: `UPDATE publication_dependencies SET outcome='cycle',inspect_due=NULL
  WHERE project_id=?1 AND child_event_id=?2 AND prerequisite_kind='prompt' AND prerequisite_id=?3 AND holder_event_id IS ?4 AND outcome='waiting' RETURNING session_id` });
const wakeReleased = write<[string, string, number, number, string]>({ name: 'publication.wakeReleased', sql: `UPDATE publish_queue SET retry_at=0 WHERE project_id=?1 AND session_id=?2 AND rank=?3 AND created_at=?4 AND event_id=?5 AND failure IS NULL
  AND EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.project_id=?1 AND d.child_event_id=?5 AND d.outcome='cycle')` });
const docDue = write<[string, string, string]>({ name: 'publication.dueAfterRelease', sql: `UPDATE session_documents SET due_at=0 WHERE project_id=?1 AND session_id=?2 AND state='live' AND due_at IS NOT 0
  AND EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.project_id=?1 AND d.child_event_id=?3 AND d.outcome='cycle')` });
const settleEdge = write<[string, string, string, string | null, string | null, number]>({ name: 'publication.settleInspection', sql: `UPDATE publication_dependencies SET inspect_due=NULL
  WHERE project_id=?1 AND child_event_id=?2 AND prerequisite_kind='prompt' AND prerequisite_id=?3 AND holder_event_id IS ?4 AND inspect_after IS ?5 AND inspect_hops=?6 AND outcome='waiting'` });
const continueEdge = write<[string, string, string, string | null, string | null, number, string, number, number]>({ name: 'publication.continueInspection', sql: `UPDATE publication_dependencies SET inspect_after=?7,inspect_hops=inspect_hops+?8,inspect_due=?9
  WHERE project_id=?1 AND child_event_id=?2 AND prerequisite_kind='prompt' AND prerequisite_id=?3 AND holder_event_id IS ?4 AND inspect_after IS ?5 AND inspect_hops=?6 AND outcome='waiting'` });

/**
 * Inspects each new prompt dependency once, from the edge itself, walking its holders in bounded hops.
 *
 * A cycle is found by the edge that closes it; every edge of a cycle is its own inspection, so a walk that never
 * reaches its start only proves the chain is long or leads into a cycle other edges will report. A walk that runs out of
 * hops checkpoints and continues on the next run; past a long bound it stays visibly pending and is checked back later
 * rather than spinning. A cycle wakes its child, which then publishes without the prerequisite it can never have.
 */
export async function inspectPublicationCycles(db: RelationalStore, now: number): Promise<{ changed: number; more: boolean }> {
  const [edges] = await readSet(db, dueEdges.bind(now));
  if (edges.length === 0) return { changed: 0, more: false };
  const walks = await Promise.all(edges.map(edge => readSet(db, walk.bind(edge.project_id, edge.inspect_after ?? edge.holder_event_id ?? edge.child_event_id, edge.child_event_id))));
  const settlements: Bound[] = [];
  const cycles: Edge[] = [];
  let more = edges.length === INSPECTION_PAGE;
  walks.forEach(([rows], index) => {
    const edge = edges[index]!, last = rows[0]!;
    const held = [edge.project_id, edge.child_event_id, edge.prerequisite_id, edge.holder_event_id] as const;
    if (edge.holder_event_id !== null && last.id === edge.child_event_id) {
      cycles.push(edge);
      settlements.push(markCycle.bind(...held), wakeReleased.bind(edge.project_id, edge.session_id, edge.child_rank, edge.child_created_at, edge.child_event_id),
        docDue.bind(edge.project_id, edge.session_id, edge.child_event_id));
    } else if (last.hops < INSPECTION_HOPS) {
      settlements.push(settleEdge.bind(...held, edge.inspect_after, edge.inspect_hops));
    } else {
      const pendingLong = edge.inspect_hops + last.hops >= INSPECTION_MAX_HOPS;
      more ||= !pendingLong;
      if (pendingLong) emit({ kind: 'document_dependency_inspection_pending', projectId: edge.project_id, sessionId: edge.session_id, eventId: edge.child_event_id, hops: edge.inspect_hops + last.hops });
      settlements.push(continueEdge.bind(...held, edge.inspect_after, edge.inspect_hops, last.id, last.hops, pendingLong ? now + INSPECTION_PENDING_DELAY_MS : now));
    }
  });
  if (settlements.length > 0) await commit(db, ...settlements);
  for (const edge of cycles) emit({ kind: 'document_dependency_cycle', projectId: edge.project_id, sessionId: edge.session_id, eventId: edge.child_event_id, prerequisite: edge.prerequisite_id });
  return { changed: settlements.length, more };
}

interface DependencyTotals { waiting: number; inspecting: number; cycles: number }
export const DEPENDENCY_STATUS = read<[], DependencyTotals>({ name: 'publication.dependencyStatus', sql: 'SELECT waiting,inspecting,cycles FROM publication_dependency_totals WHERE slot=1' });

const DEPENDENCY_PHASE_SOURCE = { table: 'publish_queue', columns: ['project_id', 'session_id', 'rank', 'created_at', 'event_id'], where: heldWait(''), startKey: ['', '', -1, -1, ''], unique: true } as const;
/** A held retry cause becomes its typed row. A prompt wait names its canonical prompt from the waiting record; when that is unreadable the holder event id is kept instead, so no source id is lost. */
const DEPENDENCY_RECONCILE = [
  write<[string]>({ name: 'publication.reconcileDependencies', sql: `INSERT INTO publication_dependencies
    (project_id,session_id,child_event_id,child_rank,child_created_at,prerequisite_kind,prerequisite_id,holder_event_id,inspect_due)
  SELECT q.project_id,q.session_id,q.event_id,q.rank,q.created_at,
    CASE json_extract(q.retry_cause,'$.kind') WHEN 'prompt' THEN 'prompt' WHEN 'order' THEN 'event' ELSE 'read' END,
    CASE json_extract(q.retry_cause,'$.kind') WHEN 'order' THEN json_extract(q.retry_cause,'$.eventId')
      WHEN 'prompt' THEN COALESCE(json_extract(q.retry_cause,'$.promptId'),CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,CASE e.kind WHEN 'prompt' THEN '$.parentPromptId' ELSE '$.promptId' END) END,json_extract(q.retry_cause,'$.eventId'))
      ELSE '' END,
    CASE WHEN json_extract(q.retry_cause,'$.kind') IN ('prompt','order') THEN json_extract(q.retry_cause,'$.eventId') END,
    CASE json_extract(q.retry_cause,'$.kind') WHEN 'prompt' THEN 0 END
  FROM (${jsonKeys(['project_id', 'session_id', 'rank', 'created_at', 'event_id'])}) k
  CROSS JOIN publish_queue q ON q.project_id=k.project_id AND q.session_id=k.session_id AND q.rank=k.rank AND q.created_at=k.created_at AND q.event_id=k.event_id
  CROSS JOIN events e ON e.project_id=q.project_id AND e.event_id=q.event_id
  WHERE q.failure IS NULL AND (json_extract(q.retry_cause,'$.kind') IN ('prompt','order')
    OR (json_extract(q.retry_cause,'$.kind')='read' AND json_extract(q.retry_cause,'$.parentId') IS NULL AND q.rank=0))
  ON CONFLICT(project_id,child_event_id,prerequisite_kind,prerequisite_id) DO NOTHING` }),
  // The session may be waiting out its translation deferral.
  write<[string]>({ name: 'publication.rearmTranslated', sql: `UPDATE session_documents SET due_at=0 WHERE state='live' AND due_at IS NOT 0 AND (project_id,session_id) IN
    (SELECT DISTINCT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1))` }),
];

export const DEPENDENCY_CATCHUP = {
  projection: DEPENDENCY_PROJECTION,
  phases: { [DEPENDENCY_PHASE]: { source: DEPENDENCY_PHASE_SOURCE, reconcile: DEPENDENCY_RECONCILE } },
} as const satisfies CatchupFamily;
