import type { PreparedStatement, RelationalStore } from '../adapters.js';
import { cosineSimilarity } from './vectors.js';
import type { EmbeddingContext, EmbeddingStep } from './reconcile.js';

/** Settled members one step reads. */
const HUBNESS_PAGE = 50;
/** The most spore vectors one operation adds or removes, which bounds one step to about a thousand distances. */
const HUBNESS_SUBJECTS = 20;
export const CURRENT_SPORE_VECTORS = `SELECT r.id FROM embedding_receipts r JOIN embedding_sources s
  ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
  WHERE r.project_id = ? AND r.model_key = ? AND r.type = 'spore' AND r.ready = 1`;

/** A member row's state: covered by every other member's moments, joining the set, or leaving it. */
const MEMBER = { settled: 0, joining: 1, leaving: 2 } as const;

/** Member row `m` names a current spore vector under its model. */
const currentMember = (m: string) => `EXISTS (SELECT 1 FROM embedding_receipts r JOIN embedding_sources s
  ON s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision
  WHERE r.project_id = ${m}.project_id AND r.model_key = ${m}.model_key AND r.id = ${m}.id AND r.type = 'spore' AND r.ready = 1)`;

/** Current spore vectors no member row names. Binds: project id, model key. */
const UNCOVERED = `${CURRENT_SPORE_VECTORS} AND NOT EXISTS (SELECT 1 FROM embedding_hubness_members m
  WHERE m.project_id = r.project_id AND m.model_key = r.model_key AND m.id = r.id)`;

/** Settled members whose moments do not count exactly the other members. Binds: project id, model key. */
const MISCOUNTED = `SELECT COALESCE(MIN(n) <> COUNT(*) - 1 OR MAX(n) <> COUNT(*) - 1, 0) AS miscounted
  FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?`;

/** Every calibration write holds only while the cursor still carries the token its step read. Binds: project id, token. */
const HOLDS = `EXISTS (SELECT 1 FROM embedding_cursors c WHERE c.project_id = ? AND c.hubness_token IS ?)`;

/** Rows carried as one JSON array of `[id, n, mean, m2, neighbor_mean, neighbor_std]`. */
const CARRIED = `v AS (SELECT json_extract(j.value, '$[0]') AS id, json_extract(j.value, '$[1]') AS n, json_extract(j.value, '$[2]') AS mean,
  json_extract(j.value, '$[3]') AS m2, json_extract(j.value, '$[4]') AS neighbor_mean, json_extract(j.value, '$[5]') AS neighbor_std FROM json_each(?) j)`;

interface Moments { n: number; mean: number; m2: number }
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

const distance = (a: Float32Array, b: Float32Array): number => 1 - cosineSimilarity(a, b);

function encodeVector(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(Float32Array.from(values).buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeVector(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/**
 * Calibration work is pending: a member of another model, an operation in progress, a member whose vector is no longer
 * current, a current vector no member covers, or settled moments that do not count the other members.
 */
export async function hubnessPending(db: RelationalStore, projectId: string, model: string): Promise<boolean> {
  const row = await db.prepare(`SELECT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ?
      AND (m.model_key <> ? OR m.state <> ${MEMBER.settled} OR NOT ${currentMember('m')}))
    OR EXISTS (${UNCOVERED}) OR (${MISCOUNTED}) AS pending`)
    .bind(projectId, model, projectId, model, projectId, model).first<{ pending: number }>();
  return row?.pending === 1;
}

/**
 * Each current spore vector's moments cover its cosine distance to every other current spore vector. The membership
 * record changes by operations of at most `HUBNESS_SUBJECTS` spore vectors, all joining or all leaving: an operation adds or
 * removes its subjects' distances on every settled member one page per step, reading vectors from the members' copies,
 * and a joining subject collects its own moments on the way. Leaving runs first, so a spore that changed leaves with its
 * old vector and joins with its new one. Each step's writes commit only against the token it read.
 */
export async function reconcileHubness(context: EmbeddingContext, projectId: string): Promise<EmbeddingStep> {
  const { db, vectors, provider } = context;
  const model = provider.modelKey;
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM (${CURRENT_SPORE_VECTORS})`).bind(projectId, model).first<{ n: number }>())!.n;
  if (count < 2) return { phase: 'settled', processed: 0 };
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
    const leaving = (await db.prepare(`SELECT m.id FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state = ${MEMBER.settled} AND NOT ${currentMember('m')} ORDER BY m.id LIMIT ?`).bind(projectId, model, HUBNESS_SUBJECTS).all<{ id: string }>()).results;
    if (leaving.length > 0) {
      started = await commit([db.prepare(`UPDATE embedding_hubness_members SET state = ${MEMBER.leaving} WHERE project_id = ? AND model_key = ?
        AND state = ${MEMBER.settled} AND id IN (SELECT value FROM json_each(?)) AND ${HOLDS}`)
        .bind(projectId, model, JSON.stringify(leaving.map((r) => r.id)), projectId, token)], ', hubness_cursor = NULL');
    } else {
      const joining = (await db.prepare(`${UNCOVERED} ORDER BY r.id LIMIT ?`).bind(projectId, model, HUBNESS_SUBJECTS).all<{ id: string }>()).results;
      if (joining.length === 0) {
        const { miscounted } = (await db.prepare(MISCOUNTED).bind(projectId, model).first<{ miscounted: number }>())!;
        if (miscounted !== 1) return { phase: 'settled', processed: 0 };
        const done = await commit([db.prepare(`DELETE FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND ${HOLDS}`)
          .bind(projectId, model, projectId, token)], ', hubness_cursor = NULL, hubness_count = NULL');
        return { phase: 'hubness', processed: done ? 1 : 0 };
      }
      const visible = await vectors.get({ projectId, modelKey: model }, joining.map((r) => r.id));
      if (visible.length === 0) return { phase: 'visibility', processed: 0 };
      started = await commit(visible.map((v) => db.prepare(`INSERT INTO embedding_hubness_members(project_id, model_key, id, state, vector)
        SELECT ?, ?, ?, ${MEMBER.joining}, ? WHERE ${HOLDS}`).bind(projectId, model, v.id, encodeVector(v.values), projectId, token)), ', hubness_cursor = NULL');
    }
    if (!started) return { phase: 'hubness', processed: 0 };
    token = await cursorToken(db, projectId);
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
  const statements = [...carry(db, projectId, model, token, targets)];
  if (joins) statements.push(...carry(db, projectId, model, token, subjects, last));
  let done: boolean;
  if (last) {
    statements.push(joins
      ? db.prepare(`UPDATE embedding_hubness_members SET state = ${MEMBER.settled} WHERE project_id = ? AND model_key = ? AND state = ${MEMBER.joining} AND ${HOLDS}`)
        .bind(projectId, model, projectId, token)
      : db.prepare(`DELETE FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND state = ${MEMBER.leaving} AND ${HOLDS}`)
        .bind(projectId, model, projectId, token));
    done = await commit(statements, `, hubness_cursor = NULL, hubness_model = ?,
      hubness_count = (SELECT COUNT(*) FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?)`, [model, projectId, model]);
  } else {
    done = await commit(statements, ', hubness_cursor = ?', [targets[targets.length - 1]!.id]);
  }
  return { phase: 'hubness', processed: done || started ? 1 : 0 };
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

/** Writes members' moments and, for settled or settling members, the neighbour statistics their receipts carry. */
function carry(db: RelationalStore, projectId: string, model: string, token: string, rows: Loaded[], publish = true): PreparedStatement[] {
  if (rows.length === 0) return [];
  const json = JSON.stringify(rows.map((r) => [r.id, r.n, r.mean, r.m2, ...neighborStats(r)]));
  const statements = [db.prepare(`WITH ${CARRIED} UPDATE embedding_hubness_members SET n = (SELECT v.n FROM v WHERE v.id = embedding_hubness_members.id),
    mean = (SELECT v.mean FROM v WHERE v.id = embedding_hubness_members.id), m2 = (SELECT v.m2 FROM v WHERE v.id = embedding_hubness_members.id)
    WHERE project_id = ? AND model_key = ? AND id IN (SELECT id FROM v) AND ${HOLDS}`).bind(json, projectId, model, projectId, token)];
  if (publish) statements.push(db.prepare(`WITH ${CARRIED} UPDATE embedding_receipts SET neighbor_mean = (SELECT v.neighbor_mean FROM v WHERE v.id = embedding_receipts.id),
    neighbor_std = (SELECT v.neighbor_std FROM v WHERE v.id = embedding_receipts.id)
    WHERE project_id = ? AND model_key = ? AND id IN (SELECT id FROM v) AND ${HOLDS}`).bind(json, projectId, model, projectId, token));
  return statements;
}
