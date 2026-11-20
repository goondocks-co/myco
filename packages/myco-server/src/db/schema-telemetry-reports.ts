import { projectIdGrammar } from './project-id.js';

const profile = (
  row: string,
) => `project_id=${row}.project_id AND session_id=${row}.session_id AND parent_project_id=${row}.parent_project_id
 AND parent_session_id=${row}.parent_session_id AND key_id=${row}.key_id AND matched_by=${row}.matched_by AND evidence=${row}.evidence AND service_name=COALESCE(${row}.service_name,'')`;
const add = (
  row: string,
) => `INSERT INTO telemetry_lineage_reports(project_id,session_id,parent_project_id,parent_session_id,key_id,matched_by,evidence,service_name,claims)
 SELECT ${row}.project_id,${row}.session_id,${row}.parent_project_id,${row}.parent_session_id,${row}.key_id,${row}.matched_by,${row}.evidence,COALESCE(${row}.service_name,''),1
 WHERE ${row}.parent_session_id IS NOT NULL ON CONFLICT DO UPDATE SET claims=claims+1;`;
const remove = (row: string) => `UPDATE telemetry_lineage_reports SET claims=claims-1 WHERE ${profile(row)};
 DELETE FROM telemetry_lineage_reports WHERE ${profile(row)} AND claims=0;`;
/** A repeated invocation contributes to its report profile rather than growing the lineage read. */
export const TELEMETRY_REPORT_DDL = [
  `CREATE TABLE IF NOT EXISTS telemetry_lineage_reports(project_id TEXT NOT NULL CHECK(${projectIdGrammar('project_id')}),session_id TEXT NOT NULL,
 parent_project_id TEXT NOT NULL CHECK(${projectIdGrammar('parent_project_id')}),parent_session_id TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES telemetry_keys(id),
 matched_by TEXT NOT NULL CHECK(matched_by IN('exact','inferred')),evidence TEXT NOT NULL,service_name TEXT NOT NULL,claims INTEGER NOT NULL,
 PRIMARY KEY(project_id,session_id,matched_by,parent_project_id,parent_session_id,key_id,evidence,service_name),
 FOREIGN KEY(project_id,session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE,
 FOREIGN KEY(parent_project_id,parent_session_id) REFERENCES sessions(project_id,session_id) ON DELETE CASCADE) WITHOUT ROWID`,
  'CREATE INDEX IF NOT EXISTS idx_telemetry_report_parent ON telemetry_lineage_reports(parent_project_id,parent_session_id,project_id,session_id)',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_report_key ON telemetry_lineage_reports(key_id,project_id,session_id)',
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_added AFTER INSERT ON telemetry_resolutions BEGIN ${add('NEW')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_removed AFTER DELETE ON telemetry_resolutions BEGIN ${remove('OLD')} END`,
  `CREATE TRIGGER IF NOT EXISTS telemetry_report_changed AFTER UPDATE ON telemetry_resolutions BEGIN ${remove('OLD')} ${add('NEW')} END`,
];
