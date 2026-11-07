import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import { notTombstonedSql as sessions_import_notTombstonedSql } from "../../db/session-read-model.js";

export function prepareRecordAcknowledgement(db: sessions_import_RelationalStore, projectId: string, runId: string, servedId: string, ackId: string, now: number,
  guard: { sql: string; params: readonly unknown[] }) {
  const source = `SELECT m.project_id, m.record_id, m.session_id, m.served_id FROM run_served_material m
    WHERE m.run_id = ? AND m.project_id = ? AND m.served_id = ?`;
  const params = [runId, projectId, servedId];
  return db.prepare(`INSERT INTO extraction_acks
    (project_id, ack_id, session_id, kind, record_id, served_id, run_id, acknowledged_at)
    SELECT material.project_id, ?, material.session_id, 'record', material.record_id, material.served_id, ?, ?
    FROM (${source}) material
    JOIN sessions s ON s.project_id = material.project_id AND s.session_id = material.session_id
    WHERE ${sessions_import_notTombstonedSql('s')}
      AND ${guard.sql}
      AND NOT EXISTS (SELECT 1 FROM extraction_acks a WHERE a.project_id = material.project_id
        AND a.record_id = material.record_id AND a.kind = 'record' AND a.run_id = ? AND a.served_id IS material.served_id)
    ON CONFLICT (project_id, served_id) DO NOTHING`).bind(ackId, runId, now, ...params, ...guard.params, runId);
}
