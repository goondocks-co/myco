import type { RelationalStore } from '../../core/adapters.js';
import { sessionMaterialReadySql } from './material.js';
import type { ProjectSet } from '../../read/scope.js';
import { read, readSet, type BindValue, type Statement } from '../index.js';
import { occurredAt, presentedEndedAt, presentedStartedAt } from '../session-dates.js';
import { notTombstonedSql } from '../session-read-model.js';

/** The opening of a session's first user prompt as its document catalog keeps it, for the label of a session with no title. */
export const firstPromptSql = (alias: string): string =>
  `(SELECT first_prompt FROM session_documents first_doc WHERE first_doc.project_id = ${alias}.project_id AND first_doc.session_id = ${alias}.session_id)`;

/** Presented conversation dates fall back to raw lifecycle dates. */
export const PRESENTED_STARTED_AT = presentedStartedAt('s.');
export const PRESENTED_ENDED_AT = presentedEndedAt('s.');

/** The instant a session is ordered by, spelled as `idx_sessions_occurred` and the Deployment-wide index spell it. */
export const SESSION_OCCURRED_AT = occurredAt('s.');

/** All joins land on primary keys, preserving the session row count. */
export const SESSION_COLUMNS = `s.session_id, s.machine_id, s.created_by_token_id, s.first_received_at, s.last_received_at,
     s.agent, s.branch, ${PRESENTED_STARTED_AT} AS started_at, ${PRESENTED_ENDED_AT} AS ended_at, s.origin_path, s.parent_session_id, s.parent_reason, s.launch_parent_session_id,
     s.title, s.summary, s.titled_at, s.ended_by, ${firstPromptSql('s')} AS first_prompt,
     c.member_id, c.runtime_kind, m.label AS member_label, e.label AS ended_by_label, s.working_since`;

/** The session read's joins, with the sessions table read through `indexedBy` where one is named. */
export function sessionFrom(indexedBy: string): string {
  return `FROM sessions s${indexedBy === '' ? '' : ` INDEXED BY ${indexedBy}`}
     LEFT JOIN member_credentials c ON c.id = s.created_by_token_id
     LEFT JOIN members m ON m.id = c.member_id
     LEFT JOIN members e ON e.id = s.ended_by`;
}

/** The Deployment-wide order every read of sessions across Projects walks: the instant, the id, then the Project. */
const SESSIONS_ACROSS_INDEX = 'idx_sessions_occurred_deployment';

/**
 * The index an activity window reads: it leads with the last receipt, so the read seeks the sessions received from
 * the window's start on, however long ago they started, and sorts that set alone.
 */
const SESSIONS_ACTIVE_INDEX = 'idx_sessions_capture';

/** The index the sessions working now are read through: it holds the sessions with an open turn alone. */
const SESSIONS_WORKING_INDEX = 'idx_sessions_working';

/**
 * How long a turn may stay open and still read as working. A turn ends when its end reaches the Deployment; this
 * bounds only a turn whose end never does (a crash, an interrupt no hook reports), which reads as working no longer.
 */
export const WORKING_CAP_MS = 3 * 60 * 60 * 1000;

const LIVE_SESSION = notTombstonedSql('s');

/** Every primary and sibling transcript is fully parsed at full fidelity. */
const FULL_FIDELITY = `${sessionMaterialReadySql('s')} AND NOT EXISTS (SELECT 1 FROM transcripts t
  WHERE t.project_id = s.project_id AND t.session_id = s.session_id
    AND t.fidelity IS NOT NULL AND t.fidelity <> 'full')`;

interface SessionBrowseFilters {
  since?: number;
  until?: number;
  branch?: string;
  agent?: string;
  window?: 'start' | 'activity';
  now?: number;
  state?: 'open' | 'ended';
  memberLabel?: string;
  sessionId?: string;
  fidelity?: 'full' | 'any';
}

/** The key after which a page starts: within one Project the instant and the id; across Projects the Project too. */
interface SessionPageKey { createdAt: number; projectId?: string; id: string }

interface SessionPageRequest {
  /** One Project, or a set of Projects read across. */
  scope: { projectId: string } | ProjectSet;
  filters: SessionBrowseFilters;
  /** Whether the page lists the sessions active in a window that opens at the filters' start instant. */
  active: boolean;
  after: SessionPageKey | null;
  limit: number;
}

/** The variants of the session page: one Project, every visible Project, or a named set; a window of starts, activity or working now. */
/** A named set of Projects binds once as `,id,id,`: the Project id grammar holds no comma, so membership is one exact check per row. */
type Scope = 'project' | 'all' | 'named';
type Window = 'start' | 'activity' | 'working';
interface Shape { scope: Scope; window: Window; since: boolean; until: boolean; session: boolean; after: boolean }
type Values = Record<string, BindValue>;
interface Variant { statement: Statement<BindValue[], Record<string, unknown>, 'read'>; slots: readonly string[] }

const ENDED = PRESENTED_ENDED_AT;
const O = SESSION_OCCURRED_AT;
const flags = [false, true] as const;
const cap = (word: string, on: boolean) => (on ? word : '');

/** `{name}` markers become numbered slots in order of first use. */
function define(name: string, template: string): Variant {
  const slots: string[] = [];
  const sql = template.replace(/\{([a-z]+)\}/gi, (_, slot: string) => {
    if (!slots.includes(slot)) slots.push(slot);
    return `?${slots.indexOf(slot) + 1}`;
  });
  return { statement: read<BindValue[], Record<string, unknown>>({ name, sql }), slots };
}

function variantSql(shape: Shape): string {
  const { scope, window, since, until, session, after } = shape;
  const across = scope !== 'project';
  const conditions = [
    scope === 'project' ? 's.project_id = {project}'
      : scope === 'all' ? 'EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)'
      : "instr({projects}, ',' || s.project_id || ',') > 0",
    LIVE_SESSION,
    `({fidelity} = 0 OR (${FULL_FIDELITY}))`,
    '({branch} IS NULL OR s.branch = {branch})',
    '({agent} IS NULL OR s.agent = {agent})',
    '({member} IS NULL OR m.label = {member})',
    // Open and ended as the page shows them, each session under one. A session working again after its recorded end is
    // open while it works: the working read lists it as open, and a read of ended sessions judged at an instant leaves it
    // out.
    `({state} IS NULL OR ({state} = 'open' AND ${window === 'working' ? '1' : `${ENDED} IS NULL`})
      OR ({state} = 'ended' AND ${ENDED} IS NOT NULL AND ({endedAfter} IS NULL
        OR COALESCE(s.working_since <= ${ENDED} OR s.working_since <= {endedAfter}, 1))))`,
    session ? 's.session_id = {session}' : across ? '({session} IS NULL OR s.session_id = {session})' : '1',
  ];
  // Working now: a turn opened within the cap, with no end recorded or one older than the turn.
  if (window === 'working') conditions.push('s.working_since IS NOT NULL', 's.working_since > {workingAfter}', `(${ENDED} IS NULL OR ${ENDED} < s.working_since)`);
  // Active in the window: a receipt at or after its start, and no end recorded before it.
  if (window === 'activity') conditions.push('s.last_received_at >= {since}', `(${ENDED} IS NULL OR ${ENDED} >= {since})`);
  // A window of starts bounds the instant the page is ordered by, so the filter admits what the order shows.
  if (window === 'start' && since) conditions.push(`${O} >= {since}`);
  if (until) conditions.push(`${O} < {until}`);
  if (after) conditions.push(across
    ? `${O} <= {at} AND (${O} < {at} OR (${O} = {at} AND (s.session_id < {afterId} OR (s.session_id = {afterId} AND s.project_id < {afterProject}))))`
    : `${O} <= {at} AND (${O} < {at} OR (${O} = {at} AND s.session_id < {afterId}))`);
  const index = window === 'activity' ? SESSIONS_ACTIVE_INDEX : window === 'working' ? SESSIONS_WORKING_INDEX : across ? SESSIONS_ACROSS_INDEX : '';
  return `SELECT s.project_id, ${SESSION_COLUMNS} ${sessionFrom(index)} WHERE ${conditions.join(' AND ')}
    ORDER BY ${O} DESC, s.session_id DESC${across ? ', s.project_id DESC' : ''} LIMIT {limit}`;
}

const keyOf = (shape: Shape) => `${shape.scope}${shape.window[0]!.toUpperCase()}${shape.window.slice(1)}${cap('Since', shape.since)}${cap('Until', shape.until)}`
  + `${cap('Session', shape.session)}${cap('After', shape.after)}`;

/**
 * Every session page variant, defined once: a window of starts may bound its start, activity and working windows always
 * have theirs; only a one-Project page seeks one session by its key; the rest of the filters bind in every variant.
 */
const VARIANTS = new Map<string, Variant>();
for (const scope of ['project', 'all', 'named'] as const) for (const window of ['start', 'activity', 'working'] as const)
  for (const since of flags) for (const until of flags) for (const session of flags) for (const after of flags) {
    if (since && window !== 'start') continue;
    if (session && scope !== 'project') continue;
    const shape: Shape = { scope, window, since, until, session, after };
    const key = keyOf(shape);
    VARIANTS.set(key, define(`sessionBrowse.${key}`, variantSql(shape)));
  }

/**
 * One session page as stored rows, at most `limit` + 1 of them, newest occurrence first: the Project admits the rows,
 * the filters narrow them, and the order and the key are the occurred instant and the id, with the Project after them
 * across Projects. A read across Projects walks the Deployment-wide index; an activity window reads the sessions
 * received from its start on and, judged at an instant, also the sessions working now, read apart as `working`. A
 * list never matches free text: a text match is a search.
 */
export async function readSessionPage(db: RelationalStore, request: SessionPageRequest):
  Promise<{ received: Record<string, unknown>[]; working: Record<string, unknown>[] }> {
  const { scope, filters, active, after, limit } = request;
  const kind: Scope = 'projectId' in scope ? 'project' : scope.all ? 'all' : 'named';
  const values: Values = {
    project: 'projectId' in scope ? scope.projectId : null,
    projects: kind === 'named' && !('projectId' in scope) && !scope.all ? `,${scope.projectIds.join(',')},` : null,
    fidelity: (filters.fidelity ?? 'full') === 'full' ? 1 : 0,
    branch: filters.branch ?? null, agent: filters.agent ?? null, member: filters.memberLabel ?? null,
    state: filters.state ?? null, endedAfter: filters.state === 'ended' && filters.now !== undefined ? filters.now - WORKING_CAP_MS : null,
    session: filters.sessionId ?? null, since: filters.since ?? null, until: filters.until ?? null,
    workingAfter: filters.now === undefined ? null : filters.now - WORKING_CAP_MS,
    at: after?.createdAt ?? null, afterProject: after?.projectId ?? null, afterId: after?.id ?? null, limit: limit + 1,
  };
  const page = async (window: Window) => {
    const key = keyOf({ scope: kind, window, since: window === 'start' && filters.since !== undefined,
      until: filters.until !== undefined, session: kind === 'project' && filters.sessionId !== undefined, after: after !== null });
    const variant = VARIANTS.get(key);
    if (variant === undefined) throw new Error(`no session page variant ${key}`);
    const [rows] = await readSet(db, variant.statement.bind(...variant.slots.map(slot => values[slot]!)));
    return rows;
  };
  const received = await page(active ? 'activity' : 'start');
  const working = active && filters.now !== undefined ? await page('working') : [];
  return { received, working };
}
