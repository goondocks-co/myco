import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { CURATION_TASK, EXTRACTION_TASK, RETAINED_TASKS, SEEDING_TASK, TITLING_TASK, type RetainedTask } from '../core/task-catalogue.js';
import { CARD_TOOL, MAP_WRITE_TOOL, TITLE_WRITE_TOOL } from '../core/tool-catalogue.js';
import { EMBEDDING_REPORT_ACTION, EMBEDDING_TASK } from '../core/embedding/task.js';
import { RUN_WRITE_EVENT } from '../db/runs/evidence.js';

/** A terminal run's outcome, determined by the output it recorded. */
export type RunResult = 'produced' | 'unchanged' | 'failed' | 'failed_with_output';

/**
 * Where a task's run records that it changed something: spores it authored, a landed write through one tool (with a
 * positive count in that write's record, where the write records one), spore lineage it authored, or a positive count
 * in the report its runtime files.
 */
type RunOutput =
  | { kind: 'spores' }
  | { kind: 'write'; tool: string; count?: string }
  | { kind: 'lineage' }
  | { kind: 'reported'; action: string; count: string };

/** What each retained task's run leaves when it changed something. Every retained task declares one, so none reads as "changed nothing" by omission. */
const TASK_OUTPUT: Readonly<Record<RetainedTask, RunOutput>> = {
  [EXTRACTION_TASK]: { kind: 'spores' },
  [SEEDING_TASK]: { kind: 'spores' },
  [TITLING_TASK]: { kind: 'write', tool: TITLE_WRITE_TOOL },
  [MAP_TASK]: { kind: 'write', tool: MAP_WRITE_TOOL },
  // A card write on an already-complete assignment lands with nothing written; only cards it wrote count.
  [CARD_TASK]: { kind: 'write', tool: CARD_TOOL, count: '$.written' },
  [CURATION_TASK]: { kind: 'lineage' },
  [EMBEDDING_TASK]: { kind: 'reported', action: EMBEDDING_REPORT_ACTION, count: '$.processed' },
};

const wroteSpores = (a: string): string => `EXISTS (SELECT 1 FROM spores sp WHERE sp.project_id = ${a}.project_id AND sp.author = ${a}.id)`;
const recordedWrite = (a: string, tool: string, count?: string): string => `EXISTS (SELECT 1 FROM agent_run_events e
  WHERE e.project_id = ${a}.project_id AND e.run_id = ${a}.id AND e.event_type = '${RUN_WRITE_EVENT}' AND e.tool_name = '${tool}'${
  count === undefined ? '' : ` AND json_valid(e.payload) AND json_extract(e.payload, '${count}') > 0`})`;
const wroteLineage = (a: string): string => `EXISTS (SELECT 1 FROM resolution_events re WHERE re.project_id = ${a}.project_id AND re.author = ${a}.id)`;
const reportedCount = (a: string, action: string, count: string): string => `EXISTS (SELECT 1 FROM agent_reports rp
  WHERE rp.project_id = ${a}.project_id AND rp.run_id = ${a}.id AND rp.action = '${action}' AND json_valid(rp.details) AND json_extract(rp.details, '${count}') > 0)`;

function outputSql(a: string, output: RunOutput): string {
  switch (output.kind) {
    case 'spores': return wroteSpores(a);
    case 'write': return recordedWrite(a, output.tool, output.count);
    case 'lineage': return wroteLineage(a);
    case 'reported': return reportedCount(a, output.action, output.count);
  }
}

/**
 * Whether a run recorded published output of its task's kind, for runs of `tasks`. Dry runs publish no output. A
 * caller whose rows can only be some tasks' runs names them, so its statement carries only their arms.
 */
export const producedSql = (a: string, tasks: readonly string[] = RETAINED_TASKS): string => `(CASE WHEN ${a}.dry_run = 1 THEN 0 ELSE CASE ${a}.task${
  Object.entries(TASK_OUTPUT).filter(([task]) => tasks.includes(task)).map(([task, output]) => `
  WHEN '${task}' THEN ${outputSql(a, output)}`).join('')}
  ELSE 0 END END)`;

/** The same recorded-output judgment serves detail, project lists and the work window. */
export const runResultSql = (a: string): string => `(CASE
  WHEN ${a}.status = 'failed' THEN CASE WHEN ${producedSql(a)} THEN 'failed_with_output' ELSE 'failed' END
  WHEN ${a}.status = 'completed' THEN CASE WHEN ${producedSql(a)} THEN 'produced' ELSE 'unchanged' END
  ELSE NULL END)`;
