/**
 * Extraction citations admit sessions served to the run in its Project.
 * A dispatch-named session does not narrow the sessions the run may cite.
 */
import type { RelationalStore } from './adapters.js';
import { LEDGER_ENABLED_AT } from '../db/schema-v95.js';
import { writeGuardStore } from './write-guard-store.js';
import { notTombstonedSql } from './tombstones.js';
import type { ReadScope } from '../read/scope.js';

/** A captured material item identified by the canonical prompt and session ids. */
export interface PromptMaterial {
  promptId: string; sessionId: string; createdAt: number; endedAt: number | null;
  text?: string | null; response?: string | null;
}

/** A body page's item with its immutable serving identity. */
export type ServedPrompt = PromptMaterial & { servedId: string };

/** Commit the entire bounded body page before its caller can answer it. */
export async function recordServedPrompts(
  db: RelationalStore, scope: ReadScope, runId: string, rows: readonly PromptMaterial[], now: number, instanceId: string | null = null,
): Promise<ServedPrompt[]> {
  if (rows.length === 0) return [];
  const items = JSON.stringify([...new Map(rows.map(({ promptId, sessionId }) => [promptId, { promptId, sessionId, servedId: crypto.randomUUID() }])).values()]);
  const match = `m.project_id = ? AND m.run_id = ? AND m.record_id = json_extract(j.value, '$.promptId') AND m.instance_id IS ?`;
  const [, result] = await db.batch([
    db.prepare(`INSERT INTO run_served_material (project_id, served_id, run_id, session_id, record_id, served_at, instance_id)
    SELECT ?, json_extract(j.value, '$.servedId'), ?, json_extract(j.value, '$.sessionId'),
      json_extract(j.value, '$.promptId'), ?, ?
    FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM run_served_material m WHERE ${match})`)
      .bind(scope.projectId, runId, now, instanceId, items, scope.projectId, runId, instanceId),
    db.prepare(`SELECT m.record_id AS promptId, MIN(m.served_id) AS servedId FROM json_each(?) j
      CROSS JOIN run_served_material m ON ${match} GROUP BY m.record_id`)
      .bind(items, scope.projectId, runId, instanceId),
  ]);
  const identities = new Map((result!.results as { promptId: string; servedId: string }[]).map(row => [row.promptId, row.servedId]));
  return rows.map(row => {
    const servedId = identities.get(row.promptId);
    if (servedId === undefined) throw new Error('Served material was not recorded');
    return { ...row, servedId };
  });
}

/** Whether the dispatch predates the Deployment's durable ledger boundary. */
export async function dispatchedBeforeLedger(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS old FROM agent_runs r
    JOIN schema_meta m ON m.key = ?
    WHERE r.project_id = ? AND r.id = ?
      AND COALESCE(r.queued_at, r.started_at) < CAST(m.value AS INTEGER)`)
    .bind(LEDGER_ENABLED_AT, scope.projectId, runId).first();
  return row !== null;
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
