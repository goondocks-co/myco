import type { PreparedStatement, RelationalStore } from '../adapters.js';
import type { EmbeddingContext, EmbeddingStep } from './reconcile.js';
import { VECTOR_LOST_MS, VECTOR_REWRITE_LIMIT } from './provider.js';

/** Settled members one step reads. */
const HUBNESS_PAGE = 50;
/** The most spore vectors one operation adds or removes, which bounds one step to about a thousand distances. */
const HUBNESS_SUBJECTS = 20;
/** Indexed spore receipts under the model whose source revision is current. Binds: project id, model key. */
const sporeVectors = (columns: string) => `SELECT ${columns} FROM embedding_receipts r JOIN embedding_sources s
  ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
  WHERE r.project_id = ? AND r.model_key = ? AND r.type = 'spore' AND r.ready = 1`;
/** Every current spore vector, including one left out of calibration while the vector store does not return it. */
export const SPORE_VECTORS = sporeVectors('r.id');
/** The spore vectors calibration covers: current, and not left out while the vector store does not return them. */
export const CURRENT_SPORE_VECTORS = `${SPORE_VECTORS} AND r.rewrites = 0`;

/** A member row's state: covered by every other member's moments, joining the set, or leaving it. */
const MEMBER = { settled: 0, joining: 1, leaving: 2 } as const;

/** Member row `m` names a current spore vector under its model. */
const currentMember = (m: string) => `EXISTS (SELECT 1 FROM embedding_receipts r JOIN embedding_sources s
  ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
  WHERE r.project_id = ${m}.project_id AND r.model_key = ${m}.model_key AND r.id = ${m}.id AND r.type = 'spore' AND r.ready = 1 AND r.rewrites = 0)`;

const NOT_MEMBER = `NOT EXISTS (SELECT 1 FROM embedding_hubness_members m
  WHERE m.project_id = r.project_id AND m.model_key = r.model_key AND m.id = r.id)`;
/** Current spore vectors no member row names. Binds: project id, model key. */
const UNCOVERED = `${sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites = 0 AND ${NOT_MEMBER}`;
/** Spore vectors left out of calibration while the vector store does not return them. Binds: project id, model key. */
const MISSING = `${sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites > 0 AND ${NOT_MEMBER}`;
/** A left-out spore vector no longer written again: written again the most times, and still not returned `VECTOR_LOST_MS` after the last write. Binds: the lost cutoff. */
const ABANDONED = `(r.rewrites >= ${VECTOR_REWRITE_LIMIT} AND r.updated_at <= ?)`;

/** Settled members whose moments do not count exactly the other members. Binds: project id, model key. */
const MISCOUNTED = `SELECT COALESCE(MIN(n) <> COUNT(*) - 1 OR MAX(n) <> COUNT(*) - 1, 0) AS miscounted
  FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?`;

/** Every calibration write holds only while the cursor still carries the token its step read. Binds: project id, token. */
const HOLDS = `EXISTS (SELECT 1 FROM embedding_cursors c WHERE c.project_id = ? AND c.hubness_token IS ?)`;

/** Rows carried as one JSON array of `[id, n, mean, m2, neighbor_mean, neighbor_std]`. */
const CARRIED = `v AS (SELECT json_extract(j.value, '$[0]') AS id, json_extract(j.value, '$[1]') AS n, json_extract(j.value, '$[2]') AS mean,
  json_extract(j.value, '$[3]') AS m2, json_extract(j.value, '$[4]') AS neighbor_mean, json_extract(j.value, '$[5]') AS neighbor_std FROM json_each(?) j)`;

interface Moments { n: number; mean: number; m2: number }
interface Candidate { id: string; updated_at: number; rewrites: number }
interface Member extends Moments { id: string; state: number; vector: string }
interface Loaded extends Member { values: Float32Array }

/** Welford's update with one more sample. */
function include(m: Moments, x: number): Moments {
  const n = m.n + 1;
  const delta = x - m.mean;
  const mean = m.mean + delta / n;
  return { n, mean, m2: m.m2 + delta * (x - mean) };
}

/** Welford's update with one sample taken back out: the exact inverse of `include`, up to rounding. */
function exclude(m: Moments, x: number): Moments {
  if (m.n <= 1) return { n: 0, mean: 0, m2: 0 };
  const n = m.n - 1;
  const mean = (m.n * m.mean - x) / n;
  return { n, mean, m2: m.m2 - (x - m.mean) * (x - mean) };
}

/** The mean and population standard deviation a search reads; absent without a sample. */
const neighborStats = (m: Moments): [number | null, number | null] =>
  m.n === 0 ? [null, null] : [m.mean, Math.sqrt(Math.max(0, m.m2 / m.n))];

/**
 * `1 - cosineSimilarity` over copies whose zero tail is dropped: the dimensions past a copy's length are zero, so the
 * sums, and the distance, are those of the full stored vectors.
 */
function distance(a: Float32Array, b: Float32Array): number {
  const shared = Math.min(a.length, b.length);
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < shared; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; aa += x ** 2; bb += y ** 2;
  }
  for (let i = shared; i < a.length; i++) aa += a[i]! ** 2;
  for (let i = shared; i < b.length; i++) bb += b[i]! ** 2;
  return 1 - (aa === 0 || bb === 0 ? 0 : Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))));
}

/** A stored vector as float32 bytes in base64, without its zero tail. */
function encodeVector(values: ArrayLike<number>): string {
  let length = values.length;
  while (length > 0 && values[length - 1] === 0) length--;
  const floats = new Float32Array(length);
  for (let i = 0; i < length; i++) floats[i] = values[i]!;
  const bytes = new Uint8Array(floats.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** A Project's spore vectors under one model left out of calibration while the vector store does not return them. */
export interface MissingSporeVectors {
  /** Being written again, or due to be. */
  rewriting: number;
  /** Written again, and waited on for `VECTOR_LOST_MS` from that write. */
  waiting: number;
  /** Written again `VECTOR_REWRITE_LIMIT` times and still not returned; no longer written again. */
  abandoned: number;
}

export async function missingSporeVectors(db: RelationalStore, projectId: string, model: string, now: number): Promise<MissingSporeVectors> {
  const row = await db.prepare(`SELECT COALESCE(SUM(r.ready = 0 OR (r.updated_at <= ? AND r.rewrites < ${VECTOR_REWRITE_LIMIT})), 0) AS rewriting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at > ?), 0) AS waiting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at <= ? AND r.rewrites >= ${VECTOR_REWRITE_LIMIT}), 0) AS abandoned
    FROM embedding_receipts r JOIN embedding_sources s
      ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
    WHERE r.project_id = ? AND r.model_key = ? AND r.rewrites > 0 AND r.ready >= 0 AND r.type = 'spore'`)
    .bind(now - VECTOR_LOST_MS, now - VECTOR_LOST_MS, now - VECTOR_LOST_MS, projectId, model).first<MissingSporeVectors>();
  return { rewriting: row?.rewriting ?? 0, waiting: row?.waiting ?? 0, abandoned: row?.abandoned ?? 0 };
}

/**
 * Calibration work is pending: a member of another model, an operation in progress, a member whose vector is no longer
 * current, a current vector no member covers, a left-out vector that is still looked for or due to be written again,
 * statistics still to publish, or settled moments that do not count the other members.
 */
export async function hubnessPending(db: RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ?
      AND (m.model_key <> ? OR m.state <> ${MEMBER.settled} OR NOT ${currentMember('m')}))
    OR EXISTS (${UNCOVERED}) OR EXISTS (${MISSING} AND NOT ${ABANDONED})
    OR EXISTS (SELECT 1 FROM embedding_cursors c WHERE c.project_id = ? AND c.hubness_cursor IS NOT NULL) OR (${MISCOUNTED}) AS pending`)
    .bind(projectId, model, projectId, model, projectId, model, now - VECTOR_LOST_MS, projectId, projectId, model).first<{ pending: number }>();
  return row?.pending === 1;
}

/**
 * Each current spore vector's moments cover its cosine distance to every other current spore vector. The membership
 * record changes by operations of at most `HUBNESS_SUBJECTS` spore vectors, all joining or all leaving: an operation adds or
 * removes its subjects' distances on every settled member one page per step, reading vectors from the members' copies,
 * and a joining subject collects its own moments on the way. Leaving starts before joining: a joiner waits until the
 * vector store returns its vector, and a spore that is gone leaves the calibration meanwhile. A receipt's
 * neighbour statistics change only when its moments cover every other current spore vector; until then it keeps the
 * statistics it has. Each step's writes commit only against the token it read.
 *
 * A joiner is waited on for `VECTOR_LOST_MS` from its write. A vector the store still does not return then is taken as
 * lost: its receipt goes back to the write path, and its spore is left out of calibration, which publishes the other
 * members' statistics in one pass. A left-out vector is looked for on each step until `VECTOR_LOST_MS` after each new
 * write, joins once the store returns it, and is written again at most `VECTOR_REWRITE_LIMIT` times.
 */
export async function reconcileHubness(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  const { db, vectors, provider } = context;
  const model = provider.modelKey;
  const tally = async (sql: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).bind(projectId, model).first<{ n: number }>())!.n;
  if (await tally(SPORE_VECTORS) < 2) return { phase: 'settled', processed: 0 };
  let count = await tally(CURRENT_SPORE_VECTORS);
  let token = await cursorToken(db, projectId);
  const commit = async (statements: PreparedStatement[], set = '', binds: unknown[] = []): Promise<boolean> => {
    const results = await db.batch([...statements,
      db.prepare(`UPDATE embedding_cursors SET hubness_token = lower(hex(randomblob(8)))${set} WHERE project_id = ? AND hubness_token IS ?`)
        .bind(...binds, projectId, token)]);
    return results[results.length - 1]!.meta.changes === 1;
  };
  const stale = await db.prepare('SELECT 1 AS found FROM embedding_hubness_members WHERE project_id = ? AND model_key <> ? LIMIT 1').bind(projectId, model).first();
  if (stale !== null) {
    const done = await commit([db.prepare(`DELETE FROM embedding_hubness_members WHERE project_id = ? AND model_key <> ? AND ${HOLDS}`)
      .bind(projectId, model, projectId, token)], ', hubness_cursor = NULL');
    return { phase: 'hubness', processed: done ? 1 : 0 };
  }

  let subjects = await members(db, projectId, model, `state <> ${MEMBER.settled}`, [], HUBNESS_SUBJECTS);
  let started = false;
  if (subjects.length === 0) {
    let waiting = false;
    const leaving = (await db.prepare(`SELECT m.id FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state = ${MEMBER.settled} AND NOT ${currentMember('m')} ORDER BY m.id LIMIT ?`).bind(projectId, model, HUBNESS_SUBJECTS).all<{ id: string }>()).results;
    if (leaving.length > 0) {
      started = await commit([db.prepare(`UPDATE embedding_hubness_members SET state = ${MEMBER.leaving} WHERE project_id = ? AND model_key = ?
        AND state = ${MEMBER.settled} AND id IN (SELECT value FROM json_each(?)) AND ${HOLDS}`)
        .bind(projectId, model, JSON.stringify(leaving.map((r) => r.id)), projectId, token)], ', hubness_cursor = NULL');
      if (!started) return { phase: 'hubness', processed: 0 };
    } else {
      const lostBefore = now - VECTOR_LOST_MS;
      const joining = (await db.prepare(`${UNCOVERED} ORDER BY r.id LIMIT ?`).bind(projectId, model, HUBNESS_SUBJECTS).all<Candidate>()).results;
      const asked = joining.length > 0 ? joining : await leftOut(db, projectId, model, lostBefore);
      const visible = asked.length === 0 ? [] : await vectors.get({ projectId, modelKey: model }, asked.map((r) => r.id));
      const seen = new Set(visible.map((v) => v.id));
      const unseen = asked.filter((r) => !seen.has(r.id));
      const lost = unseen.filter((r) => r.updated_at <= lostBefore && r.rewrites < VECTOR_REWRITE_LIMIT);
      waiting = unseen.some((r) => r.updated_at > lostBefore);
      if (visible.length === 0 && lost.length === 0) {
        if (joining.length > 0) return { phase: 'visibility', processed: 0 };
      } else {
        const statements = visible.map((v) => db.prepare(`INSERT INTO embedding_hubness_members(project_id, model_key, id, state, vector)
          SELECT ?, ?, ?, ${MEMBER.joining}, ? WHERE ${HOLDS}`).bind(projectId, model, v.id, encodeVector(v.values), projectId, token));
        if (joining.length === 0 && visible.length > 0) {
          statements.push(db.prepare(`UPDATE embedding_receipts SET rewrites = 0 WHERE project_id = ? AND model_key = ? AND id IN (SELECT value FROM json_each(?))
            AND ready = 1 AND rewrites > 0 AND ${HOLDS}`).bind(projectId, model, JSON.stringify(visible.map((v) => v.id)), projectId, token));
        }
        if (lost.length > 0) {
          statements.push(db.prepare(`UPDATE embedding_receipts SET ready = 0, rewrites = rewrites + 1 WHERE project_id = ? AND model_key = ?
            AND id IN (SELECT value FROM json_each(?)) AND ready = 1 AND rewrites < ${VECTOR_REWRITE_LIMIT} AND updated_at <= ? AND ${HOLDS}`)
            .bind(projectId, model, JSON.stringify(lost.map((r) => r.id)), lostBefore, projectId, token));
        }
        // Joiners start an operation, whose pages publish every member; a joiner left out alone starts a publication pass.
        started = await commit(statements, visible.length > 0 ? ', hubness_cursor = NULL' : joining.length > 0 ? ", hubness_cursor = ''" : '');
        if (!started) return { phase: 'hubness', processed: 0 };
        if (visible.length === 0) return { phase: 'visibility', processed: 1 };
      }
    }
    if (!started) {
      const { miscounted } = (await db.prepare(MISCOUNTED).bind(projectId, model).first<{ miscounted: number }>())!;
      if (miscounted === 1) {
        const done = await commit([db.prepare(`DELETE FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND ${HOLDS}`)
          .bind(projectId, model, projectId, token)], ', hubness_cursor = NULL, hubness_count = NULL');
        return { phase: 'hubness', processed: done ? 1 : 0 };
      }
      const after = (await db.prepare('SELECT hubness_cursor FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ hubness_cursor: string | null }>())?.hubness_cursor ?? null;
      if (after === null) return { phase: waiting ? 'visibility' : 'settled', processed: 0 };
      // The publication pass: the settled members' statistics, one page per step.
      const page = await members(db, projectId, model, `state = ${MEMBER.settled} AND id > ?`, [after], HUBNESS_PAGE + 1);
      const last = page.length <= HUBNESS_PAGE;
      const targets = page.slice(0, HUBNESS_PAGE);
      const done = await commit(await publish(db, projectId, model, token, targets, count),
        last ? ', hubness_cursor = NULL' : ', hubness_cursor = ?', last ? [] : [targets[targets.length - 1]!.id]);
      return { phase: 'hubness', processed: done ? 1 : 0 };
    }
    token = await cursorToken(db, projectId);
    count = await tally(CURRENT_SPORE_VECTORS);
    subjects = await members(db, projectId, model, `state <> ${MEMBER.settled}`, [], HUBNESS_SUBJECTS);
    if (subjects.length === 0) return { phase: 'hubness', processed: 1 };
  }

  const joins = subjects[0]!.state === MEMBER.joining;
  const after = (await db.prepare('SELECT hubness_cursor FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ hubness_cursor: string | null }>())?.hubness_cursor ?? '';
  const page = await members(db, projectId, model, `state = ${MEMBER.settled} AND id > ?`, [after], HUBNESS_PAGE + 1);
  const last = page.length <= HUBNESS_PAGE;
  const targets = page.slice(0, HUBNESS_PAGE);
  for (const target of targets) {
    for (const subject of subjects) {
      const d = distance(subject.values, target.values);
      Object.assign(target, joins ? include(target, d) : exclude(target, d));
      if (joins) Object.assign(subject, include(subject, d));
    }
  }
  if (last && joins) {
    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const d = distance(subjects[i]!.values, subjects[j]!.values);
        Object.assign(subjects[i]!, include(subjects[i]!, d));
        Object.assign(subjects[j]!, include(subjects[j]!, d));
      }
    }
  }
  const carried = joins ? [...targets, ...subjects] : targets;
  const statements = [carry(db, projectId, model, token, carried)];
  let done: boolean;
  if (last) {
    statements.push(joins
      ? db.prepare(`UPDATE embedding_hubness_members SET state = ${MEMBER.settled} WHERE project_id = ? AND model_key = ? AND state = ${MEMBER.joining} AND ${HOLDS}`)
        .bind(projectId, model, projectId, token)
      : db.prepare(`DELETE FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND state = ${MEMBER.leaving} AND ${HOLDS}`)
        .bind(projectId, model, projectId, token));
    statements.push(...await publish(db, projectId, model, token, carried, count));
    done = await commit(statements, `, hubness_cursor = NULL, hubness_model = ?,
      hubness_count = (SELECT COUNT(*) FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?)`, [model, projectId, model]);
  } else {
    statements.push(...await publish(db, projectId, model, token, carried, count));
    done = await commit(statements, ', hubness_cursor = ?', [targets[targets.length - 1]!.id]);
  }
  return { phase: 'hubness', processed: done || started ? 1 : 0 };
}

/**
 * Left-out spore vectors to look for: those still written again first, then those no longer written again from the
 * probe cursor on, wrapping, so each one is looked for in turn. Moves the probe cursor past the last one taken.
 */
async function leftOut(db: RelationalStore, projectId: string, model: string, lostBefore: number): Promise<Candidate[]> {
  const probe = (await db.prepare('SELECT hubness_probe FROM embedding_cursors WHERE project_id = ?').bind(projectId)
    .first<{ hubness_probe: string | null }>())?.hubness_probe ?? '';
  const rows = (await db.prepare(`${MISSING} ORDER BY ${ABANDONED}, ${ABANDONED} AND r.id <= ?, r.id LIMIT ?`)
    .bind(projectId, model, lostBefore, lostBefore, probe, HUBNESS_SUBJECTS).all<Candidate>()).results;
  const next = rows.filter((r) => r.rewrites >= VECTOR_REWRITE_LIMIT && r.updated_at <= lostBefore).at(-1)?.id;
  if (next !== undefined) await db.prepare('UPDATE embedding_cursors SET hubness_probe = ? WHERE project_id = ?').bind(next, projectId).run();
  return rows;
}

/** The calibration's commit token, minted when the cursor has none. */
async function cursorToken(db: RelationalStore, projectId: string): Promise<string> {
  const read = async () => (await db.prepare('SELECT hubness_token FROM embedding_cursors WHERE project_id = ?').bind(projectId)
    .first<{ hubness_token: string | null }>())?.hubness_token ?? null;
  const held = await read();
  if (held !== null) return held;
  await db.batch([
    db.prepare('INSERT INTO embedding_cursors(project_id) VALUES (?) ON CONFLICT(project_id) DO NOTHING').bind(projectId),
    db.prepare('UPDATE embedding_cursors SET hubness_token = lower(hex(randomblob(8))) WHERE project_id = ? AND hubness_token IS NULL').bind(projectId),
  ]);
  return (await read())!;
}

async function members(db: RelationalStore, projectId: string, model: string, where: string, binds: unknown[], limit: number): Promise<Loaded[]> {
  const rows = (await db.prepare(`SELECT id, state, n, mean, m2, vector FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND ${where}
    ORDER BY id LIMIT ?`).bind(projectId, model, ...binds, limit).all<Member>()).results;
  return rows.map((r) => ({ ...r, values: decodeVector(r.vector) }));
}

/** Writes members' moments. */
function carry(db: RelationalStore, projectId: string, model: string, token: string, rows: Loaded[]): PreparedStatement {
  const json = JSON.stringify(rows.map((r) => [r.id, r.n, r.mean, r.m2]));
  return db.prepare(`WITH ${CARRIED} UPDATE embedding_hubness_members SET n = (SELECT v.n FROM v WHERE v.id = embedding_hubness_members.id),
    mean = (SELECT v.mean FROM v WHERE v.id = embedding_hubness_members.id), m2 = (SELECT v.m2 FROM v WHERE v.id = embedding_hubness_members.id)
    WHERE project_id = ? AND model_key = ? AND id IN (SELECT id FROM v) AND ${HOLDS}`).bind(json, projectId, model, projectId, token);
}

/**
 * Publishes the neighbour statistics of the rows whose moments cover every other current spore vector: the members once
 * this operation's leavers are gone are exactly the current spore vectors, and the row counts all of them but itself.
 */
async function publish(db: RelationalStore, projectId: string, model: string, token: string, rows: Loaded[], count: number): Promise<PreparedStatement[]> {
  const full = rows.filter((r) => r.n === count - 1);
  if (full.length === 0) return [];
  const { complete } = (await db.prepare(`SELECT NOT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state <> ${MEMBER.leaving} AND NOT ${currentMember('m')}) AND NOT EXISTS (${UNCOVERED}) AS complete`)
    .bind(projectId, model, projectId, model).first<{ complete: number }>())!;
  if (complete !== 1) return [];
  const json = JSON.stringify(full.map((r) => [r.id, r.n, r.mean, r.m2, ...neighborStats(r)]));
  return [db.prepare(`WITH ${CARRIED} UPDATE embedding_receipts SET neighbor_mean = (SELECT v.neighbor_mean FROM v WHERE v.id = embedding_receipts.id),
    neighbor_std = (SELECT v.neighbor_std FROM v WHERE v.id = embedding_receipts.id)
    WHERE project_id = ? AND model_key = ? AND id IN (SELECT id FROM v) AND ${HOLDS}`).bind(json, projectId, model, projectId, token)];
}
