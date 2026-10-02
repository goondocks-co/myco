import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from '../core/task-catalogue.js';
import { MAP_WRITE_TOOL, TITLE_WRITE_TOOL } from '../core/tool-catalogue.js';
import { RUN_WRITE_EVENT } from '../core/runs.js';

/** A terminal run's outcome, determined by the output it recorded. */
export type RunResult = 'produced' | 'unchanged' | 'failed' | 'failed_with_output';

const wroteSpores = (a: string): string => `EXISTS (SELECT 1 FROM spores sp WHERE sp.project_id = ${a}.project_id AND sp.author = ${a}.id)`;
const recordedWrite = (a: string, tool: string): string => `EXISTS (SELECT 1 FROM agent_run_events e
  WHERE e.project_id = ${a}.project_id AND e.run_id = ${a}.id AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = '${tool}')`;

/** Whether a run recorded published output of its task's kind. Dry runs publish no output. */
export const producedSql = (a: string): string => `(CASE WHEN ${a}.dry_run = 1 THEN 0 ELSE CASE ${a}.task
  WHEN '${EXTRACTION_TASK}' THEN ${wroteSpores(a)}
  WHEN '${SEEDING_TASK}' THEN ${wroteSpores(a)}
  WHEN '${TITLING_TASK}' THEN ${recordedWrite(a, TITLE_WRITE_TOOL)}
  WHEN '${MAP_TASK}' THEN ${recordedWrite(a, MAP_WRITE_TOOL)}
  ELSE 0 END END)`;

/** The same recorded-output judgment serves detail, project lists and the work window. */
export const runResultSql = (a: string): string => `(CASE
  WHEN ${a}.status = 'failed' THEN CASE WHEN ${producedSql(a)} THEN 'failed_with_output' ELSE 'failed' END
  WHEN ${a}.status = 'completed' THEN CASE WHEN ${producedSql(a)} THEN 'produced' ELSE 'unchanged' END
  ELSE NULL END)`;
