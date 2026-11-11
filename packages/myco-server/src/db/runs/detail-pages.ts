import type { RelationalStore } from '../../core/adapters.js';
import type { RunStepRow } from '../../read/runs.js';
import { read, readSet } from '../index.js';

export type ToolCallEventRow = { id: number; tool: string | null; durationMs: number | null; outcome: string | null; payload: string | null; recordedAt: number };
export interface AttemptRecord {
  attemptId: string; claimedAt: number; total: number | null; overflow: number | null; unrecognized: string | null;
  ownerKind: 'member' | 'runner'; runnerId: string | null; runnerName: string | null; memberId: string | null; waitedFor: string | null; waitedSince: number | null;
  runnerVersion: string | null; agentVersion: string | null;
}
export interface CanopyMapRecord { revision: string; branch: string; commitId: string; generatedAt: number; sourceRunId: string; wroteMap: number }

type Key = { createdAt: number; id: string } | null;

const CALLS = `SELECT id, tool_name AS tool, duration_ms AS durationMs, outcome, payload, recorded_at AS recordedAt
      FROM agent_run_events WHERE project_id = ?1 AND run_id = ?2 AND event_type = ?3`;
const callsFirst = read<[project: string, run: string, event: string, limit: number], ToolCallEventRow>({ name: 'runDetail.callsFirst', sql:
  `${CALLS} ORDER BY recorded_at ASC, id ASC LIMIT ?4` });
const callsAfter = read<[project: string, run: string, event: string, limit: number, at: number, id: string], ToolCallEventRow>({ name: 'runDetail.callsAfter', sql:
  `${CALLS} AND recorded_at >= ?5 AND (recorded_at > ?5 OR (recorded_at = ?5 AND id > ?6)) ORDER BY recorded_at ASC, id ASC LIMIT ?4` });

const ATTEMPT_COLUMNS = `a.attempt_id AS attemptId, a.claimed_at AS claimedAt, a.waited_for AS waitedFor, a.waited_since AS waitedSince, a.runner_version AS runnerVersion, a.agent_version AS agentVersion, a.steps_total AS total, a.steps_overflow AS overflow, a.unrecognized,
  a.owner_kind AS ownerKind, a.runner_id AS runnerId, (SELECT r.name FROM runners r WHERE r.id = a.runner_id) AS runnerName,
  CASE WHEN a.owner_kind = 'member' THEN (SELECT c.member_id FROM member_credentials c WHERE c.id = a.leased_by) END AS memberId`;
const latestAttempts = read<[project: string, run: string, limit: number], AttemptRecord>({ name: 'runDetail.latestAttempts', sql:
  `SELECT ${ATTEMPT_COLUMNS} FROM agent_run_attempts a WHERE a.project_id = ?1 AND a.run_id = ?2
      ORDER BY a.claimed_at DESC, a.attempt_id DESC LIMIT ?3` });
const attemptById = read<[project: string, run: string, attempt: string], AttemptRecord>({ name: 'runDetail.attempt', sql:
  `SELECT ${ATTEMPT_COLUMNS} FROM agent_run_attempts a WHERE a.project_id = ?1 AND a.run_id = ?2 AND a.attempt_id = ?3` });

const STEPS = `SELECT seq, call_id AS callId, kind, tool, target, outcome, exit_code AS exitCode, started_at AS startedAt, ended_at AS endedAt
      FROM agent_run_steps WHERE project_id = ?1 AND run_id = ?2 AND attempt_id = ?3`;
const stepsFirst = read<[project: string, run: string, attempt: string, limit: number], RunStepRow>({ name: 'runDetail.stepsFirst', sql:
  `${STEPS} ORDER BY seq ASC LIMIT ?4` });
const stepsAfter = read<[project: string, run: string, attempt: string, limit: number, seq: number, id: string], RunStepRow>({ name: 'runDetail.stepsAfter', sql:
  `${STEPS} AND seq >= ?5 AND (seq > ?5 OR (seq = ?5 AND seq > ?6)) ORDER BY seq ASC LIMIT ?4` });

const canopyMap = read<[project: string, run: string, event: string, tool: string], CanopyMapRecord>({ name: 'runDetail.canopyMap', sql:
  `SELECT revision, repository_branch AS branch, repository_commit AS commitId, generated_at AS generatedAt,
      source_run_id AS sourceRunId,
      EXISTS (SELECT 1 FROM agent_run_events e WHERE e.project_id = ?1 AND e.run_id = ?2 AND e.event_type = ?3 AND e.tool_name = ?4) AS wroteMap
      FROM canopy_maps WHERE project_id = ?1` });

/** Up to `limit` recorded events of one type for the run, oldest first, after the key `(recordedAt, id)` when given. */
export async function runCallEvents(db: RelationalStore, request: { project: string; run: string; event: string; after: Key; limit: number }): Promise<ToolCallEventRow[]> {
  const { project, run, event, after, limit } = request;
  const [rows] = await readSet(db, after === null ? callsFirst.bind(project, run, event, limit) : callsAfter.bind(project, run, event, limit, after.createdAt, after.id));
  return rows;
}

/** The latest `limit` attempts of a run, newest first. */
export async function latestRunAttempts(db: RelationalStore, project: string, run: string, limit: number): Promise<AttemptRecord[]> {
  const [rows] = await readSet(db, latestAttempts.bind(project, run, limit));
  return rows;
}

/** One attempt of a run, or null. */
export async function runAttemptRecord(db: RelationalStore, project: string, run: string, attempt: string): Promise<AttemptRecord | null> {
  const [[row]] = await readSet(db, attemptById.bind(project, run, attempt));
  return row ?? null;
}

/** Up to `limit` steps of an attempt in step order, after the step key when given. */
export async function attemptStepRows(db: RelationalStore, request: { project: string; run: string; attempt: string; after: Key; limit: number }): Promise<RunStepRow[]> {
  const { project, run, attempt, after, limit } = request;
  const [rows] = await readSet(db, after === null ? stepsFirst.bind(project, run, attempt, limit) : stepsAfter.bind(project, run, attempt, limit, after.createdAt, after.id));
  return rows;
}

/** The Project's current canopy map and whether this run wrote through the map tool, or null while the Project has no map. */
export async function canopyMapRecord(db: RelationalStore, project: string, run: string, request: { event: string; tool: string }): Promise<CanopyMapRecord | null> {
  const [[row]] = await readSet(db, canopyMap.bind(project, run, request.event, request.tool));
  return row ?? null;
}
