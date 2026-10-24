/** Extraction pages and history snapshots share durable acknowledgement coverage. */
import type { RelationalStore } from '../core/adapters.js';
import { MATERIAL_EXCERPT_CHARS } from '../constants.js';
import { READ_ORIGINS } from './extraction-origins.js';
export { EXTRACTION_ORIGINS, READ_ORIGINS } from './extraction-origins.js';
export { hasAcknowledgedPrompts as hasProcessedPrompts } from './extraction-coverage.js';
import { ACTIVE_EXTRACTION_CANDIDATE_SQL, EXTRACTION_CANDIDATE_SQL } from '../db/session-read-model.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { binaryOrder, clampLimit, decodeCursor, encodeCursor, page, type Page, type ReadScope } from './scope.js';
import { unreadPromptSql } from './extraction-coverage.js';

/** The captured session supporting an extraction finding, within the run's Project. */
export async function extractionSourceSession(db: RelationalStore, scope: ReadScope, promptId: string): Promise<string | null> {
  const source = await db.prepare(`SELECT p.session_id AS sessionId FROM prompt_batches p
    JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
    WHERE p.project_id = ? AND p.prompt_id = ? AND p.origin IN (${READ_ORIGINS.map(() => '?').join(', ')}) AND ${notTombstonedSql('s')}`)
    .bind(scope.projectId, promptId, ...READ_ORIGINS).first<{ sessionId: string }>();
  return source?.sessionId ?? null;
}
export interface UnprocessedPrompt {
  promptId: string; sessionId: string; createdAt: number; endedAt: number | null;
  text?: string | null; response?: string | null;
}
export interface UnprocessedOptions {
  limit?: number; cursor?: string; includeActive?: boolean; includeText?: boolean;
  history?: { receivedThrough: number; sessionIds: readonly string[] };
}
type Position = { id: string; endedAt: number | null; liveCapture: number };
type Positioned = UnprocessedPrompt & { position: Position };
type PromptCursor = string | null | false;
type HistoryCursor = { position: Position; prompt: string | false } | null | false;
type HistoryPage = { rows: readonly Positioned[]; cursor: HistoryCursor };
type SessionRead = { position: Position; after?: string };
type Cursor = { project: string; session: string; fresh: PromptCursor; history: HistoryCursor; floor: string | null };
const HISTORY_PAGE_DIVISOR = 4;
const HISTORY_EMPTY_SESSION_LOOKAHEAD = 1;
const CURSOR_PREFIX = 'ex2:';
const SESSION_ORDER = '(live_transcripts > 0) DESC, ended_at DESC, session_id DESC';
const candidateIndex = (opts: UnprocessedOptions) => opts.includeActive === true ? 'idx_session_read_unread' : 'idx_session_read_extraction';

function candidates(scope: ReadScope, opts: UnprocessedOptions) {
  const conditions = ['project_id = ?', opts.includeActive === true ? ACTIVE_EXTRACTION_CANDIDATE_SQL : EXTRACTION_CANDIDATE_SQL];
  const binds: unknown[] = [scope.projectId];
  if (opts.history !== undefined) {
    conditions.push('session_id IN (SELECT value FROM json_each(?))');
    binds.push(JSON.stringify(opts.history.sessionIds));
  }
  return { conditions, binds };
}
function candidateQuery(scope: ReadScope, opts: UnprocessedOptions, only?: string) {
  const { conditions, binds } = candidates(scope, opts);
  if (only !== undefined) { conditions.push('session_id = ?'); binds.push(only); }
  return { sql: `SELECT session_id AS id, ended_at AS endedAt, (live_transcripts > 0) AS liveCapture
    FROM session_read_facts ${only === undefined ? `INDEXED BY ${candidateIndex(opts)}` : ''}
    WHERE ${conditions.join(' AND ')} ${only === undefined ? `ORDER BY ${SESSION_ORDER}` : ''} LIMIT 1`, binds };
}
/** Candidate ranges seek within one live group and completion range. */
async function candidatePositions(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions, limit: number, primary: string, after?: Position) {
  const positions: Position[] = [];
  for (const liveCapture of [1, 0]) for (const nullEnd of opts.includeActive === true ? [false, true] : [false]) {
    if (after !== undefined && (liveCapture > after.liveCapture
      || (liveCapture === after.liveCapture && after.endedAt === null && !nullEnd))) continue;
    const { conditions, binds } = candidates(scope, opts);
    conditions.push('(live_transcripts > 0) = ?', nullEnd ? 'ended_at IS NULL' : 'ended_at IS NOT NULL', 'session_id != ?');
    binds.push(liveCapture, primary);
    if (after !== undefined && liveCapture === after.liveCapture && nullEnd === (after.endedAt === null)) {
      conditions.push(nullEnd ? 'session_id < ?' : '(ended_at, session_id) < (?, ?)');
      binds.push(...(nullEnd ? [after.id] : [after.endedAt, after.id]));
    }
    const found = (await db.prepare(`SELECT session_id AS id, ended_at AS endedAt, (live_transcripts > 0) AS liveCapture
      FROM session_read_facts INDEXED BY ${candidateIndex(opts)}
      WHERE ${conditions.join(' AND ')} ORDER BY ended_at DESC, session_id DESC LIMIT ?`)
      .bind(...binds, limit - positions.length).all<Position>()).results;
    positions.push(...found);
    if (positions.length === limit) return { positions, exhausted: false };
  }
  return { positions, exhausted: true };
}
async function readyPosition(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions, id: string) {
  const query = candidateQuery(scope, opts, id);
  return db.prepare(query.sql).bind(...query.binds).first<Position>();
}
/** The indexed primary extraction selection, with its Project binding. */
export function newestUnprocessedSessionQuery(scope: ReadScope, opts: Pick<UnprocessedOptions, 'history'> = {}) { return candidateQuery(scope, opts); }
/** The primary completed session, preferring live capture over imports. */
export async function newestUnprocessedSession(db: RelationalStore, scope: ReadScope, opts: Pick<UnprocessedOptions, 'history'> = {}): Promise<(Position & { endedAt: number }) | null> {
  const query = newestUnprocessedSessionQuery(scope, opts);
  return db.prepare(query.sql).bind(...query.binds).first<Position & { endedAt: number }>();
}
/** Snapshot cutoffs are checked only within sessions the unread counter admits. */
function snapshotCondition(opts: UnprocessedOptions) {
  if (opts.history === undefined) return { sql: '1', binds: [] as unknown[] };
  const source = `SELECT 1 FROM prompt_batches p INDEXED BY idx_prompt_batches_turns
    WHERE p.project_id = session_read_facts.project_id AND p.session_id = session_read_facts.session_id
      AND ${unreadPromptSql('p')} AND p.received_at <= ? LIMIT 1`;
  return { sql: `EXISTS (${source})`, binds: [opts.history.receivedThrough] };
}
/** An existence seek over ready counters, with a bounded snapshot probe when requested. */
export async function hasUnreadPrompts(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions = {}): Promise<boolean> {
  const { conditions, binds } = candidates(scope, opts), snapshot = snapshotCondition(opts);
  return await db.prepare(`SELECT 1 AS found FROM session_read_facts INDEXED BY ${candidateIndex(opts)} WHERE ${[...conditions, snapshot.sql].join(' AND ')} LIMIT 1`)
    .bind(...binds, ...snapshot.binds).first() !== null;
}
/** Each origin and cursor class reads all selected sessions in one prepared statement. */
async function readPositions(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions, sessions: SessionRead[]): Promise<Positioned[]> {
  const limit = clampLimit(opts.limit);
  const groups = [false, true].map(hasCursor => sessions.flatMap((session, slot) => {
    if ((session.after !== undefined) !== hasCursor) return [];
    const after = session.after === undefined ? undefined : decodeCursor(session.after);
    if (after === null) throw new Error('Invalid extraction cursor');
    return [{ slot, id: session.position.id, after }];
  })).filter(group => group.length > 0);
  const partitions = await Promise.all(groups.flatMap(group => READ_ORIGINS.map(async origin => {
    const conditions = ['p.project_id = ?', "p.session_id = json_extract(j.value, '$.id')", 'p.origin = ?', unreadPromptSql('p')];
    const binds: unknown[] = [scope.projectId, origin];
    if (opts.history !== undefined) { conditions.push('p.received_at <= ?'); binds.push(opts.history.receivedThrough); }
    if (group[0]!.after !== undefined) conditions.push("(p.created_at, p.prompt_id) > (json_extract(j.value, '$.after.createdAt'), json_extract(j.value, '$.after.id'))");
    return (await db.prepare(`SELECT json_extract(j.value, '$.slot') AS slot,
      (SELECT json_group_array(json_object('promptId', promptId, 'sessionId', sessionId, 'createdAt', createdAt, 'endedAt', endedAt))
        FROM (SELECT p.prompt_id AS promptId, p.session_id AS sessionId, p.created_at AS createdAt, p.ended_at AS endedAt
          FROM prompt_batches p INDEXED BY idx_prompt_batches_turns
          WHERE ${conditions.join(' AND ')} ORDER BY p.created_at, p.prompt_id LIMIT ?)) AS prompts
      FROM json_each(?) j`).bind(...binds, limit + 1, JSON.stringify(group)).all<{ slot: number; prompts: string }>()).results;
  })));
  return partitions.flat().flatMap(({ slot, prompts }) =>
    (JSON.parse(prompts) as UnprocessedPrompt[]).map(row => ({ ...row, position: sessions[slot]!.position, slot })))
    .sort((a, b) => a.slot - b.slot || a.createdAt - b.createdAt || binaryOrder(a.promptId, b.promptId))
    .map(({ slot: _slot, ...row }) => row);
}
/** Bodies are read only for the exact identities selected for the returned page. */
async function withBodies(db: RelationalStore, scope: ReadScope, rows: UnprocessedPrompt[]): Promise<UnprocessedPrompt[]> {
  if (rows.length === 0) return rows;
  const bodies = (await db.prepare(`SELECT p.prompt_id AS promptId, p.text AS text,
    (SELECT substr(r.text, 1, ?) FROM responses r WHERE r.project_id = p.project_id AND r.session_id = p.session_id
      AND r.prompt_id = p.prompt_id AND r.text IS NOT NULL ORDER BY r.created_at, r.response_id LIMIT 1) AS response
    FROM json_each(?) j CROSS JOIN prompt_batches p ON p.project_id = ? AND p.prompt_id = j.value`)
    .bind(MATERIAL_EXCERPT_CHARS, JSON.stringify(rows.map(row => row.promptId)), scope.projectId)
    .all<{ promptId: string; text: string | null; response: string | null }>()).results;
  const byId = new Map(bodies.map(row => [row.promptId, row]));
  return rows.flatMap(row => {
    const body = byId.get(row.promptId);
    return body === undefined ? [] : [{ ...row, text: body.text, response: body.response }];
  });
}
async function readHistory(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions, primary: string, after: HistoryCursor, floor: string | null): Promise<HistoryPage> {
  if (after === false) return { rows: [], cursor: false };
  const limit = clampLimit(opts.limit);
  const visitLimit = limit + HISTORY_EMPTY_SESSION_LOOKAHEAD;
  const sessions: SessionRead[] = [];
  if (after !== null && after.prompt !== false && await readyPosition(db, scope, opts, after.position.id) !== null) {
    sessions.push({ position: after.position, after: after.prompt });
  }
  const candidates = await candidatePositions(db, scope, opts, visitLimit - sessions.length, primary, after === null ? undefined : after.position);
  sessions.push(...candidates.positions.map(position => ({ position, after: floor ?? undefined })));
  const rows = await readPositions(db, scope, opts, sessions);
  const result = page(rows, limit, row => ({ createdAt: row.createdAt, id: row.promptId }));
  const last = result.rows.at(-1);
  return { rows: result.rows, cursor: result.cursor !== null ? { position: last!.position, prompt: result.cursor }
    : candidates.exhausted || sessions.length === 0 ? false : { position: sessions.at(-1)!.position, prompt: false } };
}
const validPrompt = (value: unknown): value is PromptCursor => value === null || value === false || (typeof value === 'string' && decodeCursor(value) !== null);
function validPosition(value: unknown): value is Position {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Partial<Position>;
  return typeof p.id === 'string' && p.id.length > 0 && (p.liveCapture === 0 || p.liveCapture === 1) && (p.endedAt === null || Number.isSafeInteger(p.endedAt));
}
function parseCursor(value: string, scope: ReadScope): Cursor {
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(CURSOR_PREFIX.length)); } catch { throw new Error('Invalid extraction cursor'); }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid extraction cursor');
  const c = parsed as Partial<Cursor>;
  if (c.project !== scope.projectId || typeof c.session !== 'string' || c.session.length === 0 || !validPrompt(c.fresh)
    || !(c.history === null || c.history === false || (typeof c.history === 'object' && validPosition(c.history.position)
      && (c.history.prompt === false || (typeof c.history.prompt === 'string' && decodeCursor(c.history.prompt) !== null))))
    || !(c.floor === null || (typeof c.floor === 'string' && decodeCursor(c.floor) !== null))) throw new Error('Invalid extraction cursor');
  return c as Cursor;
}
/** The pinned primary gets three quarters; history follows candidate-session order, then prompt order. */
export async function listUnprocessedPrompts(db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions = {}): Promise<Page<UnprocessedPrompt>> {
  let cursor: Cursor;
  let initialPosition: Position | undefined;
  if (opts.cursor?.startsWith(CURSOR_PREFIX)) {
    cursor = parseCursor(opts.cursor, scope);
  } else if (opts.cursor?.startsWith('ex1:')) {
    let old: unknown;
    try { old = JSON.parse(opts.cursor.slice(4)); } catch { throw new Error('Invalid extraction cursor'); }
    if (!Array.isArray(old) || old.length !== 3 || typeof old[0] !== 'string' || old[0].length === 0 || !validPrompt(old[1]) || !validPrompt(old[2])) throw new Error('Invalid extraction cursor');
    cursor = { project: scope.projectId, session: old[0], fresh: old[1], history: old[2] === false ? false : null, floor: typeof old[2] === 'string' ? old[2] : null };
  } else {
    const floor = opts.cursor ?? null;
    if (floor !== null && decodeCursor(floor) === null) throw new Error('Invalid extraction cursor');
    let newest: Position | null = await newestUnprocessedSession(db, scope, { history: opts.history });
    if (newest === null && opts.includeActive === true) {
      const query = candidateQuery(scope, opts);
      newest = await db.prepare(query.sql).bind(...query.binds).first<Position>();
    }
    if (newest === null) return { rows: [], cursor: null };
    initialPosition = newest;
    cursor = { project: scope.projectId, session: newest.id, fresh: floor, history: null, floor };
  }
  const limit = clampLimit(opts.limit);
  const [fresh, history] = await Promise.all([
    (async (): Promise<Page<Positioned>> => {
      if (cursor.fresh === false) return { rows: [], cursor: null };
      const position = initialPosition ?? await readyPosition(db, scope, opts, cursor.session);
      if (position === null) return { rows: [], cursor: null };
      const rows = await readPositions(db, scope, { ...opts, limit }, [{ position, after: cursor.fresh ?? undefined }]);
      return page(rows, limit, row => ({ createdAt: row.createdAt, id: row.promptId }));
    })(),
    readHistory(db, scope, { ...opts, limit }, cursor.session, cursor.history, cursor.floor),
  ]);
  const reserved = limit === 1 ? 0 : Math.max(1, Math.floor(limit / HISTORY_PAGE_DIVISOR));
  const historyCount = Math.min(history.rows.length, limit - Math.min(fresh.rows.length, limit - reserved));
  const freshCount = Math.min(fresh.rows.length, limit - historyCount);
  const lastFresh = fresh.rows[freshCount - 1], lastHistory = history.rows[historyCount - 1];
  const next: Cursor = { ...cursor,
    fresh: freshCount === fresh.rows.length && fresh.cursor === null ? false : lastFresh === undefined ? cursor.fresh : encodeCursor(lastFresh.createdAt, lastFresh.promptId),
    history: historyCount === history.rows.length ? history.cursor : lastHistory === undefined ? cursor.history
      : { position: lastHistory.position, prompt: encodeCursor(lastHistory.createdAt, lastHistory.promptId) } };
  const rows = [...fresh.rows.slice(0, freshCount), ...history.rows.slice(0, historyCount)].map(({ position: _position, ...row }) => row);
  return { rows: opts.includeText === true ? await withBodies(db, scope, rows) : rows,
    cursor: next.fresh === false && next.history === false ? null : CURSOR_PREFIX + JSON.stringify(next) };
}
