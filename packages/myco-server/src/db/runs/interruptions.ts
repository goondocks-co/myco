import { MAX_CONSECUTIVE_INTERRUPTION_ATTEMPTS } from '@goondocks/myco-shared/run-control';
import { trigger, type Trigger } from '../ddl.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';

export const SUBJECT_INTERRUPTED = 'run_interrupted';
export const SUBJECT_INTERRUPTED_REPEATED = 'run_interrupted_repeated';
export const INTERRUPTION_CODES = [SUBJECT_INTERRUPTED, SUBJECT_INTERRUPTED_REPEATED, 'execution_abandoned', 'title_interrupted_repeated'] as const;
const codes = INTERRUPTION_CODES.map(code => `'${code}'`).join(',');

/** Consecutive interruptions belong to the canonical Project, task and subject. */
export const subjectInterruptions = (project: string, task: string, subject: string): string =>
  `COALESCE((SELECT interruptions FROM run_subject_interruptions WHERE project_id=${project} AND task=${task} AND subject=${subject}),0)`;
export const subjectCanRetry = (project: string, task: string, subject: string): string =>
  `${subjectInterruptions(project, task, subject)}<${MAX_CONSECUTIVE_INTERRUPTION_ATTEMPTS}`;

export function subjectInterruptionSchema(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS run_subject_interruptions(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id) ON DELETE CASCADE,
      task TEXT NOT NULL,subject TEXT NOT NULL,interruptions INTEGER NOT NULL CHECK(interruptions>=0),PRIMARY KEY(project_id,task,subject))`,
    ...subjectInterruptionTriggers().map(item => item.sql),
  ];
}

function subjectInterruptionTriggers(): Trigger[] {
  return [
    trigger('run_subject_interrupted', 'agent_runs', 'UPDATE OF status', [
      `INSERT INTO run_subject_interruptions(project_id,task,subject,interruptions) VALUES(NEW.project_id,NEW.task,NEW.subject,1)
        ON CONFLICT(project_id,task,subject) DO UPDATE SET interruptions=interruptions+1`,
    ], `NEW.status IN ('skipped','failed') AND OLD.status='running' AND NEW.subject IS NOT NULL AND NEW.task IS NOT NULL AND NEW.error_code IN ('${SUBJECT_INTERRUPTED}','${SUBJECT_INTERRUPTED_REPEATED}')`),
    trigger('run_subject_completed', 'agent_runs', 'UPDATE OF status', [
      'DELETE FROM run_subject_interruptions WHERE project_id=NEW.project_id AND task=NEW.task AND subject=NEW.subject',
    ], "NEW.status='completed' AND OLD.status='running' AND NEW.subject IS NOT NULL"),
  ];
}

export const isInterruptedRunSql = (row: string): string => `${row}.status IN ('skipped','failed') AND ${row}.error_code IN (${codes})`;

import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';

const endings = read<[keys: string], { projectId: string; runId: string; code: string; machine: string | null }>({
  name: 'runs.interruptedEndings', sql: `SELECT r.project_id AS projectId,r.id AS runId,r.error_code AS code,
    COALESCE((SELECT n.name FROM runners n WHERE n.id=r.leased_runner_id),
      (SELECT COALESCE(m.label,c.runtime_label) FROM member_credentials c LEFT JOIN machine_claims m ON m.machine_id=c.machine_id WHERE c.id=r.leased_by)) AS machine
    FROM json_each(?1) k JOIN agent_runs r ON r.project_id=json_extract(k.value,'$.projectId') AND r.id=json_extract(k.value,'$.runId')
    WHERE r.error_code IN (${codes})`,
});

/** Admin reads name the machine that held the interrupted attempt. */
export async function interruptedEndings(db: RelationalStore, keys: readonly { projectId: string; runId: string }[]) {
  return keys.length === 0 ? [] : rows(db, endings.bind(JSON.stringify(keys)));
}

/** A completed attempt resolves interruptions of that same canonical subject. */
export const subjectCompletionAt = (row: string): string => `COALESCE((SELECT started_at FROM agent_runs c INDEXED BY idx_run_subject_completed
  WHERE c.project_id=${row}.project_id AND c.task=${row}.task AND c.subject=${row}.subject AND c.status='completed' ORDER BY c.started_at DESC LIMIT 1),0)`;
