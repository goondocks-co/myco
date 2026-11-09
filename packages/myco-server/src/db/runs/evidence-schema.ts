import { write } from '../index.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';

/**
 * Run evidence as keyed rows: how many attempts and admitted calls a run holds and how many steps each attempt received,
 * maintained where the evidence is written, so a page or a total never walks a run's history. `run_bodies` records the
 * immutable blob a moved instruction or report body lives in; a row exists only once its bytes were verified.
 */
export const RUN_EVIDENCE_PROJECTION = 'run_evidence';
export const RUN_EVIDENCE_PHASES = ['evidenceRuns', 'evidenceAttempts'] as const;
export const RUN_EVIDENCE_READY_SQL = `(SELECT COUNT(*) FROM projection_catchup WHERE projection='${RUN_EVIDENCE_PROJECTION}' AND done=1)=${RUN_EVIDENCE_PHASES.length}`;

const seedHead = `INSERT INTO run_head(project_id,run_id,attempts,calls,calls_failed)
  SELECT k.project_id,k.run_id,
    (SELECT COUNT(*) FROM agent_run_attempts a WHERE a.project_id=k.project_id AND a.run_id=k.run_id),
    (SELECT COUNT(*) FROM agent_run_events e WHERE e.project_id=k.project_id AND e.run_id=k.run_id AND e.event_type='run_tool'),
    (SELECT COUNT(*) FROM agent_run_events e WHERE e.project_id=k.project_id AND e.run_id=k.run_id AND e.event_type='run_tool' AND e.outcome='failed')
  FROM (SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS run_id FROM json_each(?1)) k
  WHERE EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=k.project_id AND r.id=k.run_id)
  ON CONFLICT(project_id,run_id) DO UPDATE SET attempts=excluded.attempts,calls=excluded.calls,calls_failed=excluded.calls_failed`;
const seedAttempt = `INSERT INTO attempt_head(project_id,run_id,attempt_id,received)
  SELECT k.project_id,k.run_id,k.attempt_id,
    (SELECT COUNT(*) FROM agent_run_steps s WHERE s.project_id=k.project_id AND s.run_id=k.run_id AND s.attempt_id=k.attempt_id)
  FROM (SELECT json_extract(value,'$[0]') AS project_id,json_extract(value,'$[1]') AS run_id,json_extract(value,'$[2]') AS attempt_id FROM json_each(?1)) k
  WHERE EXISTS(SELECT 1 FROM agent_run_attempts a WHERE a.project_id=k.project_id AND a.run_id=k.run_id AND a.attempt_id=k.attempt_id)
  ON CONFLICT(project_id,run_id,attempt_id) DO UPDATE SET received=excluded.received`;
export const RUN_EVIDENCE_CATCHUP = {
  evidenceRuns: [write<[string]>({ name: 'runs.evidenceRunPage', sql: seedHead })],
  evidenceAttempts: [write<[string]>({ name: 'runs.evidenceAttemptPage', sql: seedAttempt })],
};

/** Bytes at which a body stops being inline; a shorter one is a bounded preview-sized value and stays on its row. */
export const RUN_BODY_INLINE_BYTES = 4096;

const moved = (column: string) => `${column} IS NOT NULL AND length(CAST(${column} AS BLOB))>=${RUN_BODY_INLINE_BYTES}`;
export const RUN_BODY_DUE = `status IN ('completed','failed','skipped') AND resumable=0 AND ${moved('instruction')}`;
export const REPORT_BODY_DUE = `(${moved('details')}) OR (${moved('audit')})`;

/** The run that `project` and `run` name is not being retired. */
export const runNotRetiring = (project: string, run: string): string =>
  `NOT EXISTS (SELECT 1 FROM run_retirements x WHERE x.project_id = ${project} AND x.run_id = ${run})`;
