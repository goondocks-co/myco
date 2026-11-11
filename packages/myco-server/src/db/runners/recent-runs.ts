/**
 * One runner's recent runs, newest claim first, read from its attempts across Projects through
 * `idx_runner_attempt_history`, and the runner's own facts: its name, state and last check-in.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { runResultSql } from '../runs/run-output.js';
import { first, read, readSet } from '../index.js';
import { runNotRetiring } from '../runs/evidence-schema.js';
import { requestedProfileValue } from '../run-profile.js';
import { attemptHarnessSql } from '../runs/attempt-harness.js';

/** One attempt this runner claimed, with the run it belongs to and how that run stands. */
export interface RunnerAttemptRow {
  attempt_id: string;
  claimed_at: number;
  project_id: string;
  project_name: string | null;
  run_id: string;
  task: string | null;
  status: string;
  completed_at: number | null;
  error_code: string | null;
  result: string | null;
  /** 1 where this attempt is the run's latest claim, so the run's status is this attempt's; 0 where a later claim took it on. */
  latest: number;
  /** The versions the attempt ran with: the runner's, as it last reported it at the claim, and the coding agent's the claim reported. */
  runner_version: string | null;
  agent_version: string | null;
  /** The harness this attempt was claimed for (from its recorded profile), the profile the run's dispatch asked for, and its recorded accounting (where its identity lives). */
  harness: string | null;
  requested_profile: string | null;
  usage_data: string | null;
}

const columns = `a.attempt_id,a.claimed_at,a.project_id,(SELECT p.name FROM projects p WHERE p.project_id=a.project_id) AS project_name,
  a.run_id,r.task,r.status,r.completed_at,r.error_code,${runResultSql('r')} AS result,
  a.runner_version,a.agent_version,${attemptHarnessSql('a')} AS harness,${requestedProfileValue('r.')} AS requested_profile,r.usage_data,
  NOT EXISTS(SELECT 1 FROM agent_run_attempts l WHERE l.project_id=a.project_id AND l.run_id=a.run_id
    AND (l.claimed_at>a.claimed_at OR (l.claimed_at=a.claimed_at AND l.attempt_id>a.attempt_id))) AS latest`;
const attempts = (keyed: boolean) => `SELECT ${columns}
  FROM agent_run_attempts a INDEXED BY idx_runner_attempt_history CROSS JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
  WHERE a.runner_id=?1 ${keyed ? 'AND a.claimed_at<=?3 AND (a.claimed_at,a.attempt_id,a.project_id,a.run_id)<(?3,?4,?5,?6)' : ''} AND ${runNotRetiring('a.project_id', 'a.run_id')}
  ORDER BY a.claimed_at DESC,a.attempt_id DESC,a.project_id DESC,a.run_id DESC LIMIT ?2`;
const firstPage = read<[runner: string, limit: number], RunnerAttemptRow>({ name: 'runners.recentRuns', sql: attempts(false) });
const laterPage = read<[runner: string, limit: number, claimedAt: number, attemptId: string, projectId: string, runId: string], RunnerAttemptRow>({ name: 'runners.recentRunsAfter', sql: attempts(true) });

/**
 * One claim's place in a runner's history. An attempt id is the claiming credential's, shared by every run that
 * credential claimed, so the run's own key settles claims made at one instant.
 */
export interface RunnerAttemptKey { claimedAt: number; attemptId: string; projectId: string; runId: string }

/** Up to `limit` of a runner's attempts, newest claim first, after `cursor` where one is given. */
export async function runnerAttempts(db: RelationalStore, runnerId: string, limit: number, cursor?: RunnerAttemptKey): Promise<RunnerAttemptRow[]> {
  const [rows] = await readSet(db, cursor === undefined ? firstPage.bind(runnerId, limit)
    : laterPage.bind(runnerId, limit, cursor.claimedAt, cursor.attemptId, cursor.projectId, cursor.runId));
  return rows;
}

/** A runner by its id, with its latest check-in; null for a runner the Deployment never registered. */
export interface RunnerFactsRow { id: string; name: string; state: string; last_seen_at: number | null; version: string | null }
const facts = read<[runner: string], RunnerFactsRow>({ name: 'runners.facts', sql: `SELECT r.id,r.name,r.state,c.last_seen_at,c.version
  FROM runners r LEFT JOIN runner_contacts c ON c.runner_id=r.id WHERE r.id=?1` });
export const runnerFacts = (db: RelationalStore, runnerId: string): Promise<RunnerFactsRow | null> => first(db, facts.bind(runnerId));
