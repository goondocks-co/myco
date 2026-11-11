/**
 * One runner's recent runs, newest claim first, read from its attempts across Projects through
 * `idx_runner_attempt_history`, and the runner's own facts: its name, state and last check-in.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { runResultSql } from '../../read/run-outcome.js';
import { first, read, readSet } from '../index.js';
import { runNotRetiring } from '../runs/evidence-schema.js';

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
}

const columns = `a.attempt_id,a.claimed_at,a.project_id,(SELECT p.name FROM projects p WHERE p.project_id=a.project_id) AS project_name,
  a.run_id,r.task,r.status,r.completed_at,r.error_code,${runResultSql('r')} AS result,
  NOT EXISTS(SELECT 1 FROM agent_run_attempts l WHERE l.project_id=a.project_id AND l.run_id=a.run_id
    AND (l.claimed_at>a.claimed_at OR (l.claimed_at=a.claimed_at AND l.attempt_id>a.attempt_id))) AS latest`;
const attempts = (keyed: boolean) => `SELECT ${columns}
  FROM agent_run_attempts a INDEXED BY idx_runner_attempt_history CROSS JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
  WHERE a.runner_id=?1 ${keyed ? 'AND (a.claimed_at<?3 OR (a.claimed_at=?3 AND a.attempt_id<?4))' : ''} AND ${runNotRetiring('a.project_id', 'a.run_id')}
  ORDER BY a.claimed_at DESC,a.attempt_id DESC LIMIT ?2`;
const firstPage = read<[runner: string, limit: number], RunnerAttemptRow>({ name: 'runners.recentRuns', sql: attempts(false) });
const laterPage = read<[runner: string, limit: number, claimedAt: number, attemptId: string], RunnerAttemptRow>({ name: 'runners.recentRunsAfter', sql: attempts(true) });

/** Up to `limit` of a runner's attempts, newest claim first, after `cursor` where one is given. */
export async function runnerAttempts(db: RelationalStore, runnerId: string, limit: number, cursor?: { claimedAt: number; attemptId: string }): Promise<RunnerAttemptRow[]> {
  const [rows] = await readSet(db, cursor === undefined ? firstPage.bind(runnerId, limit) : laterPage.bind(runnerId, limit, cursor.claimedAt, cursor.attemptId));
  return rows;
}

/** A runner by its id, with its latest check-in; null for a runner the Deployment never registered. */
export interface RunnerFactsRow { id: string; name: string; state: string; last_seen_at: number | null; version: string | null }
const facts = read<[runner: string], RunnerFactsRow>({ name: 'runners.facts', sql: `SELECT r.id,r.name,r.state,c.last_seen_at,c.version
  FROM runners r LEFT JOIN runner_contacts c ON c.runner_id=r.id WHERE r.id=?1` });
export const runnerFacts = (db: RelationalStore, runnerId: string): Promise<RunnerFactsRow | null> => first(db, facts.bind(runnerId));
