import { projectIdGrammar } from './project-id.js';
const refresh = (row: string) =>
  `
 DELETE FROM telemetry_lineage_reports WHERE key_id=${row}.key_id AND project_id=${row}.project_id AND session_id=${row}.session_id;
 INSERT INTO telemetry_lineage_reports(key_id,project_id,session_id,parent_project_id,parent_session_id,matched_by,service_name,trace_id,span_id)
 SELECT key_id,project_id,session_id,parent_project_id,parent_session_id,matched_by,COALESCE(service_name,''),trace_id,span_id
 FROM telemetry_resolutions WHERE key_id=${row}.key_id AND project_id=${row}.project_id AND session_id=${row}.session_id AND parent_session_id IS NOT NULL
 ORDER BY matched_by,reported_at DESC,started_at DESC,trace_id DESC,span_id DESC LIMIT 1;`.trim();
/** One key's latest strongest report is its sole contribution to a child's parent. */
export const TELEMETRY_REPORT_DDL = [
  `CREATE TABLE IF NOT EXISTS telemetry_lineage_reports(key_id TEXT NOT NULL REFERENCES telemetry_keys(id),
 project_id TEXT NOT NULL CHECK(${projectIdGrammar('project_id')}),session_id TEXT NOT NULL,
 parent_project_id TEXT NOT NULL CHECK(${projectIdGrammar('parent_project_id')}),parent_session_id TEXT NOT NULL,
 matched_by TEXT NOT NULL CHECK(matched_by IN('exact','inferred')),service_name TEXT NOT NULL,trace_id TEXT NOT NULL,span_id TEXT NOT NULL,
 PRIMARY KEY(project_id,session_id,key_id),
 FOREIGN KEY(key_id,trace_id,span_id) REFERENCES telemetry_resolutions(key_id,trace_id,span_id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE,
 FOREIGN KEY(parent_project_id,parent_session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_report_parent ON telemetry_lineage_reports(parent_project_id,parent_session_id,project_id,session_id)',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_report_key ON telemetry_lineage_reports(key_id,project_id,session_id)',
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_added AFTER INSERT ON telemetry_resolutions BEGIN ${refresh('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_removed AFTER DELETE ON telemetry_resolutions BEGIN ${refresh('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_changed AFTER UPDATE ON telemetry_resolutions BEGIN ${refresh('OLD')} ${refresh('NEW')} END`,
];
