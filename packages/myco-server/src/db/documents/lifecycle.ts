import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../../constants.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { read, readSet, write } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * A session's lifecycle facts, kept as one keyed row beside its session.
 *
 * Triggers on `events` create the row at the first lifecycle event and apply each event's own contribution, so
 * a foreground commit never reads a session's history. Each contribution is a merge: latest end by instant, earliest
 * import end, earliest instant per prompt identity, latest member prompt, a live-source flag. The same merge run over
 * history in any order, or twice, gives the same row, which is what lets the catch-up build a historical session in
 * pages of source events while new events keep arriving: `built` marks a session the walk has passed, and each
 * completed session settles once, in the page that finishes it.
 *
 * Until a session is built its facts are partial, so decisions read the standing session columns and only known
 * turns (`building` on the session read); the winning start is never rebuilt here, its `sessions.facts_event_id`
 * and `started_at` remain the authoritative tuple from the event commit.
 */
export const LIFECYCLE_PROJECTION = 'session_lifecycle';
export const LIFECYCLE_PHASE = 'sessionLifecycle';
const LIFECYCLE_KINDS = "kind IN ('session.start','session.end','prompt','transcript.segment')";

/** A lifecycle event's instant, read from its payload, or from its archived column once the payload is archived. */
const endInstant = (alias: string) => `CASE WHEN ${alias}.payload_format='archived' THEN ${alias}.archived_ended_at
  ELSE COALESCE(CASE WHEN json_valid(${alias}.payload) THEN json_extract(${alias}.payload,'$.endedAt') END,${alias}.created_at) END`;
/** An import's end that names no instant and carries a title, which titles the session and changes nothing of its lifecycle. */
const importTitleOnly = (alias: string) => `(${alias}.channel='import' AND COALESCE(CASE WHEN ${alias}.payload_format='archived' THEN ${alias}.archived_title_only_end
  ELSE (json_valid(${alias}.payload) AND json_type(${alias}.payload,'$.endedAt') IS NULL AND json_type(${alias}.payload,'$.title') IS NOT NULL) END,0))`;
const promptOrigin = (alias: string) => `(CASE WHEN ${alias}.payload_format='archived' THEN ${alias}.archived_prompt_origin
  ELSE CASE WHEN json_valid(${alias}.payload) THEN json_extract(${alias}.payload,'$.origin') END END)`;
const promptIdentity = (alias: string) => `COALESCE(CASE WHEN json_valid(${alias}.payload) THEN json_extract(${alias}.payload,'$.promptId') END,${alias}.event_id)`;
/** The later end wins; at one instant the smaller event id does, the order the session's end commit provenance already records. */
const endBeats = (instant: string, event: string, row = '') => `(${row}end_at IS NULL OR ${instant}>${row}end_at OR (${instant}=${row}end_at AND ${event}<${row}end_event_id))`;
/** The earliest import end by creation time, then event id. */
const importEndBeats = (createdAt: string, event: string, row = '') => `(${row}import_end_created_at IS NULL OR ${createdAt}<${row}import_end_created_at OR (${createdAt}=${row}import_end_created_at AND ${event}<${row}import_end_event_id))`;

/** The index on `events`, the largest table: built alone, in a step that does nothing else. */
export const SESSION_LIFECYCLE_EVENTS_INDEX = `CREATE INDEX IF NOT EXISTS idx_events_lifecycle ON events(project_id,session_id,created_at,event_id) WHERE ${LIFECYCLE_KINDS}`;

export function sessionLifecycleSchema(): string[] {
  /** A session's first lifecycle event has seen its whole history, so the row is built from the start. */
  const firstEver = (at: string) => `NOT EXISTS(SELECT 1 FROM events prior WHERE prior.project_id=${at}.project_id AND prior.session_id=${at}.session_id AND prior.${LIFECYCLE_KINDS} AND prior.event_id<>${at}.event_id)`;
  const row = (at: string) => `INSERT INTO session_lifecycle_facts(project_id,session_id,built) VALUES(${at}.project_id,${at}.session_id,${firstEver(at)}) ON CONFLICT DO NOTHING;`;
  const update = (at: string, set: string, where: string) =>
    `UPDATE session_lifecycle_facts SET ${set} WHERE project_id=${at}.project_id AND session_id=${at}.session_id AND ${where};`;
  const liveSource = (at: string) => update(at, 'live_sources=1', `live_sources=0 AND ${at}.channel<>'import'`);
  return [
    'ALTER TABLE events ADD COLUMN actor TEXT',
    `CREATE TABLE IF NOT EXISTS session_lifecycle_facts(
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      end_event_id TEXT,end_at INTEGER,end_actor TEXT,
      import_end_event_id TEXT,import_end_created_at INTEGER,import_end_at INTEGER,
      latest_user_prompt_at INTEGER,member_prompt_at INTEGER,
      live_sources INTEGER NOT NULL DEFAULT 0 CHECK (live_sources IN (0,1)),
      built INTEGER NOT NULL DEFAULT 0 CHECK (built IN (0,1)),
      PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS session_user_prompt_firsts(
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,identity TEXT NOT NULL,first_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,session_id,identity)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_session_user_prompt_firsts_latest ON session_user_prompt_firsts(project_id,session_id,first_at DESC)',
    `CREATE TRIGGER IF NOT EXISTS session_lifecycle_start AFTER INSERT ON events WHEN NEW.kind='session.start' BEGIN ${row('NEW')} ${liveSource('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_lifecycle_end AFTER INSERT ON events WHEN NEW.kind='session.end' AND NOT ${importTitleOnly('NEW')} BEGIN ${row('NEW')}
      ${update('NEW', `end_event_id=NEW.event_id,end_at=${endInstant('NEW')},end_actor=NEW.actor`, endBeats(endInstant('NEW'), 'NEW.event_id'))}
      ${update('NEW', `import_end_event_id=NEW.event_id,import_end_created_at=NEW.created_at,import_end_at=${endInstant('NEW')}`, `NEW.channel='import' AND ${importEndBeats('NEW.created_at', 'NEW.event_id')}`)}
      ${liveSource('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_lifecycle_prompt AFTER INSERT ON events WHEN NEW.kind='prompt' AND ${promptOrigin('NEW')}='user' BEGIN ${row('NEW')}
      INSERT INTO session_user_prompt_firsts(project_id,session_id,identity,first_at) VALUES(NEW.project_id,NEW.session_id,${promptIdentity('NEW')},NEW.created_at)
        ON CONFLICT(project_id,session_id,identity) DO UPDATE SET first_at=MIN(first_at,excluded.first_at) WHERE excluded.first_at<first_at;
      ${update('NEW', `latest_user_prompt_at=(SELECT first_at FROM session_user_prompt_firsts p WHERE p.project_id=NEW.project_id AND p.session_id=NEW.session_id ORDER BY p.first_at DESC LIMIT 1),
        member_prompt_at=CASE WHEN NEW.producer_adapter<>'${TRANSCRIPT_PARSE_ADAPTER}' THEN MAX(COALESCE(member_prompt_at,0),NEW.created_at) ELSE member_prompt_at END`, '1')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_lifecycle_segment AFTER INSERT ON events WHEN NEW.kind='transcript.segment' BEGIN ${row('NEW')} ${liveSource('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_lifecycle_other AFTER INSERT ON events WHEN (NEW.kind='prompt' AND ${promptOrigin('NEW')} IS NOT 'user') OR (NEW.kind='session.end' AND ${importTitleOnly('NEW')}) BEGIN ${row('NEW')} END`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${LIFECYCLE_PROJECTION}','${LIFECYCLE_PHASE}',NOT EXISTS(SELECT 1 FROM events WHERE ${LIFECYCLE_KINDS}) ON CONFLICT DO NOTHING`,
  ];
}

/** A session is built once the walk passed it; every session is, once the walk finished. */
const READY = `(f.built=1 OR EXISTS(SELECT 1 FROM projection_catchup c WHERE c.projection='${LIFECYCLE_PROJECTION}' AND c.phase='${LIFECYCLE_PHASE}' AND c.done=1))`;
/** The latest user prompt a session's live document holds, read by the `created_at` seek on its generation. */
const DOCUMENT_TURN = `(SELECT p.created_at FROM session_prompts p WHERE p.project_id=sessions.project_id AND p.session_id=sessions.session_id AND p.origin='user'
  AND p.generation=(SELECT d.generation FROM session_documents d WHERE d.project_id=sessions.project_id AND d.session_id=sessions.session_id AND d.state='live')
  ORDER BY p.created_at DESC LIMIT 1)`;
const TURN = `MAX(COALESCE(f.latest_user_prompt_at,0),COALESCE(${DOCUMENT_TURN},0))`;
const END_STANDS = `(f.end_at IS NOT NULL AND f.end_at>=${TURN})`;
/** The end the facts name when they name one; a session whose facts name no end keeps the end it holds until a newer turn reopens it. */
const SETTLED_END_AT = `CASE WHEN f.end_at IS NOT NULL THEN CASE WHEN f.end_at>=${TURN} THEN f.end_at END WHEN sessions.ended_at<${TURN} THEN NULL ELSE sessions.ended_at END`;
const SETTLED_END_BY = `CASE WHEN f.end_at IS NOT NULL THEN CASE WHEN f.end_at>=${TURN} THEN f.end_actor END WHEN sessions.ended_at<${TURN} THEN NULL ELSE sessions.ended_by END`;
/** Whether an end at this instant applies while a session is still building: newer than the standing end and not older than a known turn. */
const buildingEndApplies = (instant: string) => `((sessions.ended_at IS NULL OR ${instant}>sessions.ended_at) AND ${instant}>=${TURN})`;
/** Import alone accounts for the lifecycle: the winning start is its own, no live start, end, segment or transcript reached the session, and no member's human turn stands after the import's end. */
const IMPORT_OWNS = `(EXISTS(SELECT 1 FROM events fe WHERE fe.project_id=sessions.project_id AND fe.event_id=sessions.facts_event_id AND fe.channel='import') AND f.live_sources=0
  AND COALESCE(f.member_prompt_at,0)<=COALESCE(f.import_end_at,0)
  AND NOT EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=sessions.project_id AND t.session_id=sessions.session_id AND t.imported_at IS NULL))`;

/** Spelled as the kind catalogue's admission gate spells it, so a gate that reads projections recognises it. */
const RAW_ROW_GATE = 'EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)';
const FACTS = `session_lifecycle_facts f WHERE sessions.project_id=?1 AND sessions.session_id=?2 AND f.project_id=?1 AND f.session_id=?2`;

const settleEnd = write<[string, string, number | null, string, number, string | null, string, string, string], { applied: number }>({ name: 'lifecycle.settleEnd', sql: `UPDATE sessions SET
  ended_at=CASE WHEN ${READY} THEN ${SETTLED_END_AT} WHEN ${buildingEndApplies('?5')} THEN ?5 ELSE sessions.ended_at END,
  ended_by=CASE WHEN ${READY} THEN ${SETTLED_END_BY} WHEN ${buildingEndApplies('?5')} THEN ?6 ELSE sessions.ended_by END,
  titling_requested_at=CASE WHEN ?3 IS NULL THEN titling_requested_at
    WHEN CASE WHEN ${READY} THEN f.end_event_id IS ?4 AND ${END_STANDS} ELSE ${buildingEndApplies('?5')} END THEN MIN(COALESCE(titling_requested_at,?3),?3) ELSE titling_requested_at END
  FROM ${FACTS} AND ${RAW_ROW_GATE} RETURNING 1 AS applied` });
const REOPENED_END_AT = `CASE WHEN ${READY} THEN ${SETTLED_END_AT} WHEN sessions.ended_at<${TURN} THEN NULL ELSE sessions.ended_at END`;
const REOPENED_END_BY = `CASE WHEN ${READY} THEN ${SETTLED_END_BY} WHEN sessions.ended_at<${TURN} THEN NULL ELSE sessions.ended_by END`;
const settleTurnSql = (extraSql: string) => `UPDATE sessions SET ended_at=${REOPENED_END_AT},ended_by=${REOPENED_END_BY}
  FROM ${FACTS}${extraSql} AND (sessions.ended_at IS NOT (${REOPENED_END_AT}) OR sessions.ended_by IS NOT (${REOPENED_END_BY}))`;
const settleTurnStatement = write<[string, string, string, string, string]>({ name: 'lifecycle.settleTurn', sql: settleTurnSql(` AND ${RAW_ROW_GATE}`) });
const settlePublished = write<[string, string]>({ name: 'lifecycle.settlePublishedTurn', sql: settleTurnSql('') });
const ensureRow = write<[string, string]>({ name: 'lifecycle.ensureRow', sql: `INSERT INTO session_lifecycle_facts(project_id,session_id,built)
  VALUES(?1,?2,NOT EXISTS(SELECT 1 FROM events prior WHERE prior.project_id=?1 AND prior.session_id=?2 AND prior.${LIFECYCLE_KINDS})) ON CONFLICT DO NOTHING` });

const MIN_DERIVED = `(SELECT MIN(p.created_at) FROM session_prompts p JOIN session_documents d ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live' WHERE p.project_id=sessions.project_id AND p.session_id=sessions.session_id)`;
const MAX_DERIVED = `(SELECT last_record_at FROM session_documents d WHERE d.project_id=sessions.project_id AND d.session_id=sessions.session_id AND d.state='live')`;
const presentedColumns = (minSql: string, maxSql: string) =>
  `occurred_started_at=CASE WHEN NOT ${READY} THEN sessions.occurred_started_at WHEN ${IMPORT_OWNS} THEN ${minSql} END,
  occurred_ended_at=CASE WHEN NOT ${READY} THEN sessions.occurred_ended_at WHEN ${IMPORT_OWNS} AND f.import_end_at IS NOT NULL THEN ${maxSql} END`;
const presented = (minSql: string, maxSql: string, gate: string) => `UPDATE sessions SET ${presentedColumns(minSql, maxSql)} FROM ${FACTS}${gate}`;
const presentedEvent = write<[string, string, string, string, string]>({ name: 'lifecycle.presentedDatesEvent', sql: presented(MIN_DERIVED, MAX_DERIVED, ` AND ${RAW_ROW_GATE}`) });
const presentedSegment = write<[string, string, string, string, string, string, number]>({ name: 'lifecycle.presentedDatesSegment', sql: presented(MIN_DERIVED, MAX_DERIVED,
  ` AND ${RAW_ROW_GATE} AND EXISTS (SELECT 1 FROM transcript_segments WHERE project_id=?1 AND transcript_id=?6 AND base_offset=?7 AND event_id=?4)`) });
const presentedPublished = write<[string, string, number, number | null]>({ name: 'lifecycle.presentedDatesPublished', sql: presented(
  `(SELECT sp.created_at FROM session_prompts sp WHERE sp.project_id=?1 AND sp.session_id=?2 AND sp.generation=?3 AND sp.turn_key=sp.prompt_id ORDER BY sp.ord LIMIT 1)`,
  `MAX(COALESCE((SELECT d.last_record_at FROM session_documents d WHERE d.project_id=?1 AND d.session_id=?2),0),COALESCE(?4,0))`, '') });

/** The page of lifecycle events a catch-up step applies; each key is [project,session,created_at,event]. */
const PAGE = `(SELECT e.project_id,e.session_id,e.event_id,e.kind,e.channel,e.created_at,e.producer_adapter,e.actor,e.payload,e.payload_format,e.archived_ended_at,e.archived_title_only_end,e.archived_prompt_origin
  FROM json_each(?1) j CROSS JOIN events e ON e.project_id=json_extract(j.value,'$[0]') AND e.event_id=json_extract(j.value,'$[3]'))`;
const frontierAt = (i: number) => `(SELECT json_extract(frontier,'$[${i}]') FROM projection_catchup WHERE projection='${LIFECYCLE_PROJECTION}' AND phase='${LIFECYCLE_PHASE}')`;
const lastKeyAt = (i: number) => `json_extract(?1,'$[#-1][${i}]')`;
/** The sessions this page finishes: no later lifecycle event under the walk's frontier remains for them. */
const COMPLETED = `(SELECT DISTINCT p.project_id,p.session_id FROM ${PAGE} p WHERE (p.project_id,p.session_id)<>(${lastKeyAt(0)},${lastKeyAt(1)}) OR NOT EXISTS (SELECT 1 FROM events later INDEXED BY idx_events_lifecycle
    WHERE later.project_id=p.project_id AND later.session_id=p.session_id AND later.${LIFECYCLE_KINDS}
      AND (later.created_at,later.event_id)>(${lastKeyAt(2)},${lastKeyAt(3)})
      AND ((p.project_id,p.session_id)<(${frontierAt(0)},${frontierAt(1)}) OR (later.created_at,later.event_id)<=(${frontierAt(2)},${frontierAt(3)}))))`;
const FACT_ROW = 'session_lifecycle_facts.';
const pageWinner = (source: string) => `w AS (SELECT * FROM (${source}) WHERE n=1)`;
const inWinners = `session_lifecycle_facts.project_id=w.project_id AND session_lifecycle_facts.session_id=w.session_id
    AND (session_lifecycle_facts.project_id,session_lifecycle_facts.session_id) IN (SELECT project_id,session_id FROM w)`;

const LIFECYCLE_RECONCILE = [
  // An end from before events recorded their actor takes it from the session that still shows it, before the winner is read below.
  write<[string]>({ name: 'lifecycle.pageActors', sql: `UPDATE events SET actor=s.ended_by FROM ${PAGE} p CROSS JOIN sessions s ON s.project_id=p.project_id AND s.session_id=p.session_id
    WHERE events.project_id=p.project_id AND events.event_id=p.event_id AND events.actor IS NULL AND p.kind='session.end' AND NOT ${importTitleOnly('p')}
      AND (${endInstant('p')})=s.ended_at AND s.ended_by IS NOT NULL` }),
  write<[string]>({ name: 'lifecycle.pageRows', sql: `INSERT INTO session_lifecycle_facts(project_id,session_id) SELECT DISTINCT project_id,session_id FROM ${PAGE} WHERE true ON CONFLICT DO NOTHING` }),
  write<[string]>({ name: 'lifecycle.pageFirsts', sql: `INSERT INTO session_user_prompt_firsts(project_id,session_id,identity,first_at)
    SELECT e.project_id,e.session_id,${promptIdentity('e')} identity,MIN(e.created_at) FROM ${PAGE} e WHERE e.kind='prompt' AND ${promptOrigin('e')}='user'
    GROUP BY e.project_id,e.session_id,identity ON CONFLICT(project_id,session_id,identity) DO UPDATE SET first_at=MIN(first_at,excluded.first_at) WHERE excluded.first_at<first_at` }),
  write<[string]>({ name: 'lifecycle.pagePrompts', sql: `UPDATE session_lifecycle_facts SET
    latest_user_prompt_at=(SELECT first_at FROM session_user_prompt_firsts p WHERE p.project_id=session_lifecycle_facts.project_id AND p.session_id=session_lifecycle_facts.session_id ORDER BY p.first_at DESC LIMIT 1),
    member_prompt_at=NULLIF(MAX(COALESCE(member_prompt_at,0),COALESCE((SELECT MAX(e.created_at) FROM ${PAGE} e WHERE e.project_id=session_lifecycle_facts.project_id AND e.session_id=session_lifecycle_facts.session_id
      AND e.kind='prompt' AND e.producer_adapter<>'${TRANSCRIPT_PARSE_ADAPTER}' AND ${promptOrigin('e')}='user'),0)),0)
    WHERE (project_id,session_id) IN (SELECT DISTINCT e.project_id,e.session_id FROM ${PAGE} e WHERE e.kind='prompt' AND ${promptOrigin('e')}='user')` }),
  write<[string]>({ name: 'lifecycle.pageEnds', sql: `WITH ${pageWinner(`SELECT e.project_id,e.session_id,e.event_id,${endInstant('e')} at,e.actor,
      ROW_NUMBER() OVER (PARTITION BY e.project_id,e.session_id ORDER BY ${endInstant('e')} DESC,e.event_id) n FROM ${PAGE} e WHERE e.kind='session.end' AND NOT ${importTitleOnly('e')}`)}
    UPDATE session_lifecycle_facts SET end_event_id=w.event_id,end_at=w.at,end_actor=w.actor FROM w WHERE ${inWinners} AND ${endBeats('w.at', 'w.event_id', FACT_ROW)}` }),
  write<[string]>({ name: 'lifecycle.pageImportEnds', sql: `WITH ${pageWinner(`SELECT e.project_id,e.session_id,e.event_id,e.created_at,${endInstant('e')} at,
      ROW_NUMBER() OVER (PARTITION BY e.project_id,e.session_id ORDER BY e.created_at,e.event_id) n FROM ${PAGE} e WHERE e.kind='session.end' AND e.channel='import' AND NOT ${importTitleOnly('e')}`)}
    UPDATE session_lifecycle_facts SET import_end_event_id=w.event_id,import_end_created_at=w.created_at,import_end_at=w.at FROM w WHERE ${inWinners} AND ${importEndBeats('w.created_at', 'w.event_id', FACT_ROW)}` }),
  write<[string]>({ name: 'lifecycle.pageLiveSources', sql: `UPDATE session_lifecycle_facts SET live_sources=1 WHERE live_sources=0 AND (project_id,session_id) IN
    (SELECT DISTINCT e.project_id,e.session_id FROM ${PAGE} e WHERE e.kind IN ('session.start','session.end','transcript.segment') AND e.channel<>'import')` }),
  write<[string]>({ name: 'lifecycle.pageBuilt', sql: `UPDATE session_lifecycle_facts SET built=1 WHERE built=0 AND (project_id,session_id) IN ${COMPLETED}` }),
  write<[string]>({ name: 'lifecycle.pageSettle', sql: `UPDATE sessions SET ended_at=${SETTLED_END_AT},ended_by=${SETTLED_END_BY},
    ${presentedColumns(MIN_DERIVED, MAX_DERIVED)}
    FROM session_lifecycle_facts f WHERE (sessions.project_id,sessions.session_id) IN ${COMPLETED} AND f.project_id=sessions.project_id AND f.session_id=sessions.session_id AND f.built=1` }),
];
const LIFECYCLE_PHASE_SOURCE = { table: 'events INDEXED BY idx_events_lifecycle', columns: ['project_id', 'session_id', 'created_at', 'event_id'], where: LIFECYCLE_KINDS, startKey: ['', '', -1, ''], unique: true } as const;

const sessionState = read<[string, string], { state: 'ready' | 'building' }>({ name: 'lifecycle.sessionState', sql: `SELECT CASE WHEN
    EXISTS(SELECT 1 FROM projection_catchup WHERE projection='${LIFECYCLE_PROJECTION}' AND phase='${LIFECYCLE_PHASE}' AND done=1)
    OR EXISTS(SELECT 1 FROM session_lifecycle_facts WHERE project_id=?1 AND session_id=?2 AND built=1) THEN 'ready' ELSE 'building' END state` });

/** Whether this session's lifecycle facts are complete; ended and presented state is provisional while building. */
export async function sessionLifecycleState(db: RelationalStore, project: string, session: string): Promise<'ready' | 'building'> {
  const [rows] = await readSet(db, sessionState.bind(project, session));
  return rows[0]!.state;
}

type LifecycleGate = { eventId: string; nonce: string };

/** The publisher's own document turn can reopen a session no lifecycle event has touched. */
export const ensureSessionLifecycle = (db: RelationalStore, project: string, session: string): PreparedStatement =>
  prepareBound(db, ensureRow.bind(project, session));

/** Settles the session's end from its facts, or, while it builds, from its standing end and known turns. */
interface SessionEnd { project: string; session: string; requestedAt: number | null; endedAt: number; actor: string | null; gate: LifecycleGate }
export const settleSessionEnd = (db: RelationalStore, { project, session, requestedAt, endedAt, actor, gate }: SessionEnd): PreparedStatement =>
  prepareBound(db, settleEnd.bind(project, session, requestedAt, gate.eventId, endedAt, actor, project, gate.eventId, gate.nonce));

/** A user prompt's admission settles the end from the latest turn the facts name, so a late copy of a prompt changes nothing. */
export const settleSessionTurn = (db: RelationalStore, project: string, session: string, gate: LifecycleGate): PreparedStatement =>
  prepareBound(db, settleTurnStatement.bind(project, session, project, gate.eventId, gate.nonce));

export const settlePublishedTurn = (db: RelationalStore, project: string, session: string): PreparedStatement =>
  prepareBound(db, settlePublished.bind(project, session));

export const presentedDatesAfterEvent = (db: RelationalStore, project: string, session: string, gate: LifecycleGate): PreparedStatement =>
  prepareBound(db, presentedEvent.bind(project, session, project, gate.eventId, gate.nonce));

interface SegmentDates { project: string; session: string; gate: LifecycleGate; transcriptId: string; baseOffset: number }
export const presentedDatesAfterSegment = (db: RelationalStore, { project, session, gate, transcriptId, baseOffset }: SegmentDates): PreparedStatement =>
  prepareBound(db, presentedSegment.bind(project, session, project, gate.eventId, gate.nonce, transcriptId, baseOffset));

export const presentedDatesAfterPublication = (db: RelationalStore, project: string, session: string, generation: number, lastRecordAt: number | null): PreparedStatement =>
  prepareBound(db, presentedPublished.bind(project, session, generation, lastRecordAt));

export const LIFECYCLE_CATCHUP = {
  projection: LIFECYCLE_PROJECTION,
  phases: { [LIFECYCLE_PHASE]: { source: LIFECYCLE_PHASE_SOURCE, reconcile: LIFECYCLE_RECONCILE } },
} as const satisfies CatchupFamily;
