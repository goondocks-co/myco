/**
 * Extraction citations admit sessions served to the run in its Project.
 * A dispatch-named session does not narrow the sessions the run may cite.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { writeGuardStore } from '../../core/write-guard-store.js';
import { notTombstonedSql } from '../session-read-model.js';
import type { ReadScope } from '../../read/scope.js';
import { LEDGER_ENABLED_AT } from '../schema-v95.js';
import { commit, read, write } from '../index.js';

/** A captured material item identified by the canonical prompt and session ids. */
interface PromptMaterial {
  promptId: string; sessionId: string; createdAt: number; endedAt: number | null;
  text?: string | null; response?: string | null;
}

/** A body page's item with its immutable serving identity. */
type ServedPrompt = PromptMaterial & { servedId: string };

const MATCH = `m.project_id = ?1 AND m.run_id = ?2 AND m.record_id = json_extract(j.value, '$.promptId') AND m.instance_id IS ?3`;
const servedInsert = write<[string, string, string | null, string, number]>({ name: 'runs.recordServed', sql:
  `INSERT INTO run_served_material (project_id, served_id, run_id, session_id, record_id, served_at, instance_id)
   SELECT ?1, json_extract(j.value, '$.servedId'), ?2, json_extract(j.value, '$.sessionId'), json_extract(j.value, '$.promptId'), ?5, ?3
   FROM json_each(?4) j WHERE NOT EXISTS (SELECT 1 FROM run_served_material m WHERE ${MATCH})` });
const servedIdentities = read<[string, string, string | null, string], { promptId: string; servedId: string }>({ name: 'runs.servedIdentities', sql:
  `SELECT m.record_id AS promptId, MIN(m.served_id) AS servedId FROM json_each(?4) j
   CROSS JOIN run_served_material m ON ${MATCH} GROUP BY m.record_id` });

/** Commit the entire bounded body page before its caller can answer it. */
export async function recordServedPrompts(
  db: RelationalStore, scope: ReadScope, runId: string, rows: readonly PromptMaterial[], now: number, instanceId: string | null = null,
): Promise<ServedPrompt[]> {
  if (rows.length === 0) return [];
  const items = JSON.stringify([...new Map(rows.map(({ promptId, sessionId }) => [promptId, { promptId, sessionId, servedId: crypto.randomUUID() }])).values()]);
  const [, held] = await commit(db,
    servedInsert.bind(scope.projectId, runId, instanceId, items, now),
    servedIdentities.bind(scope.projectId, runId, instanceId, items));
  const identities = new Map(held.results.map(row => [row.promptId, row.servedId]));
  return rows.map(row => {
    const servedId = identities.get(row.promptId);
    if (servedId === undefined) throw new Error('Served material was not recorded');
    return { ...row, servedId };
  });
}

const servedRecordRead = read<[string, string, string, string], { promptId: string; servedId: string | null }>({ name: 'runs.servedRecords', sql:
  `SELECT j.value AS promptId, (SELECT MIN(m.served_id) FROM run_served_material m
     WHERE m.project_id = ?1 AND m.run_id = ?2 AND m.session_id = ?3 AND m.record_id = j.value) AS servedId
   FROM json_each(?4) j` });

/** The serving identity of each named prompt in one session of a run: one keyed probe per prompt, independent of how much the run holds. */
export async function servedRecords(
  db: RelationalStore, scope: ReadScope, runId: string, sessionId: string, promptIds: readonly string[],
): Promise<Map<string, string>> {
  if (promptIds.length === 0) return new Map();
  const [held] = await commit(db, servedRecordRead.bind(scope.projectId, runId, sessionId, JSON.stringify([...new Set(promptIds)])));
  return new Map(held.results.flatMap(row => row.servedId === null ? [] : [[row.promptId, row.servedId] as const]));
}

const predatesLedger = read<[string, string, string], { old: number }>({ name: 'runs.dispatchedBeforeLedger', sql:
  `SELECT 1 AS old FROM agent_runs r JOIN schema_meta m ON m.key = ?
    WHERE r.project_id = ? AND r.id = ? AND COALESCE(r.queued_at, r.started_at) < CAST(m.value AS INTEGER)` });

/** Whether the dispatch predates the Deployment's durable ledger boundary. */
export async function dispatchedBeforeLedger(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  return (await commit(db, predatesLedger.bind(LEDGER_ENABLED_AT, scope.projectId, runId)))[0].results.length > 0;
}

const SERVED_SESSION = `SELECT 1 FROM run_served_material m
  JOIN sessions s ON s.project_id = m.project_id AND s.session_id = m.session_id
  WHERE m.project_id = ? AND m.run_id = ? AND m.session_id = ? AND ${notTombstonedSql('s')} LIMIT 1`;
const CITATION_REFUSAL_PATH = '$[session_not_served_to_run]';
export const SESSION_NOT_SERVED = 'session_id not served to this run';

export class ServedSessionRefused extends Error {
  constructor() { super(SESSION_NOT_SERVED); }
}

/** Admit a citation and keep its run, Project and surviving session bound to every mutation. */
export async function servedSessionStore(
  db: RelationalStore, scope: ReadScope, runId: string, sessionId: string,
): Promise<RelationalStore | null> {
  const params = [scope.projectId, runId, sessionId];
  if (await db.prepare(SERVED_SESSION).bind(...params).first() === null) return null;
  return writeGuardStore(db, () => db.prepare(`SELECT CASE WHEN EXISTS (${SERVED_SESSION})
    THEN 1 ELSE json_extract('[]', ?) END AS admitted`).bind(...params, CITATION_REFUSAL_PATH), error => {
    if (error instanceof Error && error.message.includes(CITATION_REFUSAL_PATH.slice(1))) throw new ServedSessionRefused();
    throw error;
  });
}
