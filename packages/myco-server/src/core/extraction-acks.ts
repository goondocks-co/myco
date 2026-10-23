import type { RelationalStore } from './adapters.js';
import { commitAttributedWrite } from './runs.js';
import { dispatchedBeforeLedger } from './served-material.js';
import { PROMPT_MARK_TOOL } from './tool-catalogue.js';
import { notTombstonedSql, NOT_TOMBSTONED_PARAMS } from './tombstones.js';
import type { ReadScope } from '../read/scope.js';
import { writeGuardStore } from './write-guard-store.js';

type AckTarget = { servedId: string; promptId?: never } | { promptId: string; servedId?: never };
export type AckResult = { marked: boolean; prompt_id: string; served_id?: string } | { ok: false; error: string };
const PROMPT_ITEMS_SQL = `SELECT MIN(served_id) AS servedId FROM run_served_material
  WHERE project_id = ? AND run_id = ? AND record_id = ? GROUP BY instance_id LIMIT 2`;
const AMBIGUOUS_PROMPT = 'prompt_id names material from multiple instances; use served_id';
const AMBIGUITY_PATH = '$[ambiguous_served_prompt]';
class AmbiguousServedPrompt extends Error {}

/** Restore durable coverage independently of run retention, excluding deleted sessions. */
export function restoreExtractionAckStatement(db: RelationalStore, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  return db.prepare(`INSERT OR IGNORE INTO extraction_acks (${columns.join(', ')})
    SELECT ${columns.map(() => '?').join(', ')} WHERE ${NOT_TOMBSTONED_PARAMS} RETURNING rowid`)
    .bind(...columns.map(column => row[column] ?? null), row.project_id, row.session_id);
}

/** Acknowledge only material belonging to this run, Project and surviving session. */
export async function acknowledgePrompt(
  db: RelationalStore, scope: ReadScope, runId: string, target: AckTarget, now: number,
): Promise<AckResult> {
  let servedId = target.servedId;
  if (servedId === undefined) {
    const { results } = await db.prepare(PROMPT_ITEMS_SQL)
      .bind(scope.projectId, runId, target.promptId).all<{ servedId: string }>();
    if (results.length > 1) return { ok: false, error: AMBIGUOUS_PROMPT };
    servedId = results[0]?.servedId;
  }
  const legacy = servedId === undefined && target.promptId !== undefined && await dispatchedBeforeLedger(db, scope, runId);
  if (servedId === undefined && !legacy) return { ok: false, error: 'material not served to this run; use served_id from a body page' };
  const source = servedId === undefined
    ? `SELECT p.project_id, p.prompt_id AS record_id, p.session_id, NULL AS served_id FROM prompt_batches p
        JOIN agent_runs r ON r.project_id = p.project_id AND r.id = ?
        WHERE p.project_id = ? AND p.prompt_id = ?`
    : `SELECT m.project_id, m.record_id, m.session_id, m.served_id FROM run_served_material m
        WHERE m.run_id = ? AND m.project_id = ? AND m.served_id = ?`;
  const params = [runId, scope.projectId, servedId ?? target.promptId];
  const item = await db.prepare(source).bind(...params).first<{ record_id: string }>();
  if (item === null) return { ok: false, error: 'material not served to this run' };
  if (target.promptId !== undefined) {
    const store = db;
    db = writeGuardStore(store, () => store.prepare(`SELECT CASE WHEN (SELECT COUNT(*) FROM (${PROMPT_ITEMS_SQL})) < 2
      THEN 1 ELSE json_extract('[]', ?) END AS admitted`).bind(scope.projectId, runId, target.promptId, AMBIGUITY_PATH), error => {
      if (error instanceof Error && error.message.includes(AMBIGUITY_PATH.slice(1))) throw new AmbiguousServedPrompt();
      throw error;
    });
  }
  const statement = db.prepare(`INSERT INTO extraction_acks
    (project_id, ack_id, session_id, kind, record_id, served_id, run_id, acknowledged_at)
    SELECT material.project_id, ?, material.session_id, 'record', material.record_id, material.served_id, ?, ?
    FROM (${source}) material
    JOIN prompt_batches p ON p.project_id = material.project_id AND p.prompt_id = material.record_id AND p.session_id = material.session_id
    JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
    WHERE ${notTombstonedSql('s')}
      AND NOT EXISTS (SELECT 1 FROM extraction_acks a WHERE a.project_id = material.project_id
        AND a.record_id = material.record_id AND a.kind = 'record' AND a.run_id = ? AND a.served_id IS material.served_id)
    ON CONFLICT (project_id, served_id) DO NOTHING`)
    .bind(crypto.randomUUID(), runId, now, ...params, runId);
  let result;
  try {
    result = await commitAttributedWrite(db, scope, statement, {
      runId, toolName: PROMPT_MARK_TOOL, op: 'mark_processed', recordedAt: now,
      detail: { prompt_id: item.record_id, ...(servedId === undefined ? {} : { served_id: servedId }) },
    });
  } catch (error) {
    if (error instanceof AmbiguousServedPrompt) return { ok: false, error: AMBIGUOUS_PROMPT };
    throw error;
  }
  return { prompt_id: item.record_id, ...(target.servedId === undefined ? {} : { served_id: target.servedId }), marked: result.meta.changes > 0 };
}
